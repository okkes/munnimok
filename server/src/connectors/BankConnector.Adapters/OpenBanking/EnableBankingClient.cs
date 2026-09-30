using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// Enable Banking (<c>api.enablebanking.com</c>): every call carries an RS256
/// JWT the operator's application key signs (issuer <c>enablebanking.com</c>,
/// audience the API, key id the application id), minted for an hour and
/// reused for fifty-five minutes. One RSA instance for the life of the
/// client — the api's transient client once disposed the key under a
/// process-wide cache and every later request signed with a dead key.
/// </summary>
internal sealed class EnableBankingClient(EnableBankingOptions options, TimeProvider time)
{
    private const string ProviderId = EnableBankingAdapter.ProviderId;
    private const int MaxPages = 10;

    private readonly Uri _base = new(options.BaseUrl.EndsWith('/') ? options.BaseUrl : options.BaseUrl + "/", UriKind.Absolute);
    private readonly Lock _jwtGate = new();
    private RSA? _key;
    private string? _jwt;
    private DateTimeOffset _jwtExpires = DateTimeOffset.MinValue;

    // ── wire shapes ─────────────────────────────────────────────────────

    public sealed record Aspsp(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("country")] string Country,
        [property: JsonPropertyName("logo")] string? Logo,
        [property: JsonPropertyName("transaction_total_days")] int? TransactionTotalDays);

    private sealed record AspspList([property: JsonPropertyName("aspsps")] List<Aspsp> Aspsps);

    private sealed record AuthResponse([property: JsonPropertyName("url")] string Url);

    private sealed record SessionAccount([property: JsonPropertyName("uid")] string? Uid);

    private sealed record SessionResponse(
        [property: JsonPropertyName("session_id")] string? SessionId,
        [property: JsonPropertyName("accounts")] List<SessionAccount>? Accounts);

    private sealed record EbAccountId([property: JsonPropertyName("iban")] string? Iban);

    private sealed record EbDetails(
        [property: JsonPropertyName("account_id")] EbAccountId? AccountId,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("currency")] string? Currency,
        [property: JsonPropertyName("owner_name")] string? OwnerName);

    private sealed record EbAmount(
        [property: JsonPropertyName("amount")] string Amount,
        [property: JsonPropertyName("currency")] string Currency);

    private sealed record EbBalance(
        [property: JsonPropertyName("balance_amount")] EbAmount BalanceAmount,
        [property: JsonPropertyName("balance_type")] string? BalanceType,
        [property: JsonPropertyName("reference_date")] string? ReferenceDate);

    private sealed record EbBalances([property: JsonPropertyName("balances")] List<EbBalance> Balances);

    private sealed record EbParty([property: JsonPropertyName("name")] string? Name);

    private sealed record EbTransaction(
        [property: JsonPropertyName("entry_reference")] string? EntryReference,
        [property: JsonPropertyName("transaction_amount")] EbAmount TransactionAmount,
        [property: JsonPropertyName("credit_debit_indicator")] string? CreditDebitIndicator,
        [property: JsonPropertyName("status")] string? Status,
        [property: JsonPropertyName("booking_date")] string? BookingDate,
        [property: JsonPropertyName("value_date")] string? ValueDate,
        [property: JsonPropertyName("transaction_date")] string? TransactionDate,
        [property: JsonPropertyName("remittance_information")] List<string>? RemittanceInformation,
        [property: JsonPropertyName("creditor")] EbParty? Creditor,
        [property: JsonPropertyName("debtor")] EbParty? Debtor,
        [property: JsonPropertyName("creditor_account")] EbAccountId? CreditorAccount,
        [property: JsonPropertyName("debtor_account")] EbAccountId? DebtorAccount);

    private sealed record EbTransactions(
        [property: JsonPropertyName("transactions")] List<EbTransaction> Transactions,
        [property: JsonPropertyName("continuation_key")] string? ContinuationKey);

    // ── calls ───────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<Aspsp>> AspspsAsync(HttpClient http, string country, CancellationToken ct) =>
        (await SendAsync<AspspList>(http, HttpMethod.Get, $"aspsps?country={Uri.EscapeDataString(country)}", null, "institutions", false, ct).ConfigureAwait(false)).Aspsps;

    /// <summary>A 90-day consent; the aggregator has no id for it until the bank has come back.</summary>
    public async Task<string> AuthUrlAsync(HttpClient http, string name, string country, string state, string redirectUrl, CancellationToken ct)
    {
        var auth = await SendAsync<AuthResponse>(http, HttpMethod.Post, "auth", new
        {
            access = new { valid_until = time.GetUtcNow().AddDays(OpenBankingManifests.ConsentDays).ToString("o") },
            aspsp = new { name, country },
            state,
            redirect_url = redirectUrl,
            psu_type = "personal",
        }, "consent", false, ct).ConfigureAwait(false);
        return auth.Url;
    }

    /// <summary>The single-use code from the bank's return becomes the session; a code already spent is the person's cue to connect again.</summary>
    public async Task<(string SessionId, IReadOnlyList<string> AccountIds)> SessionAsync(HttpClient http, string code, CancellationToken ct)
    {
        using var response = await SendAsync(http, HttpMethod.Post, "sessions", new { code }, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (body.Contains("ALREADY_AUTHORIZED", StringComparison.Ordinal))
            {
                throw new ConnectorException(ErrorCode.ChallengeExpired, $"{ProviderId}: the bank's code was already used - consent again");
            }
            throw Failure(response.StatusCode, "session", body, consentScoped: false);
        }
        var session = await response.Content.ReadFromJsonAsync<SessionResponse>(ct).ConfigureAwait(false)
                      ?? throw ConnectorException.ProviderChanged($"{ProviderId}: the session came back empty");
        if (string.IsNullOrWhiteSpace(session.SessionId))
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: the session carries no id");
        }
        return (session.SessionId, [.. (session.Accounts ?? []).Where(a => !string.IsNullOrWhiteSpace(a.Uid)).Select(a => a.Uid!)]);
    }

    public async Task DeleteSessionAsync(HttpClient http, string sessionId, CancellationToken ct)
    {
        using var response = await SendAsync(http, HttpMethod.Delete, $"sessions/{Uri.EscapeDataString(sessionId)}", null, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound) return;   // already gone is the goal state
        await EnsureAsync(response, "revoke", consentScoped: true, ct).ConfigureAwait(false);
    }

    public async Task<(string? Iban, string? Name, string? Currency)> DetailsAsync(HttpClient http, string accountId, CancellationToken ct)
    {
        var details = await SendAsync<EbDetails>(http, HttpMethod.Get, $"accounts/{Uri.EscapeDataString(accountId)}/details", null, "account details", true, ct).ConfigureAwait(false);
        return (details.AccountId?.Iban, details.Name ?? details.OwnerName, details.Currency);
    }

    public async Task<IReadOnlyList<(string Type, string Amount, string Currency, string? Date)>> BalancesAsync(HttpClient http, string accountId, CancellationToken ct)
    {
        var result = await SendAsync<EbBalances>(http, HttpMethod.Get, $"accounts/{Uri.EscapeDataString(accountId)}/balances", null, "balances", true, ct).ConfigureAwait(false);
        return [.. result.Balances.Select(b => (MapBalanceType(b.BalanceType), b.BalanceAmount.Amount, b.BalanceAmount.Currency, b.ReferenceDate))];
    }

    /// <summary>
    /// Continuation-key pagination, capped; an out-of-range <c>date_from</c>
    /// that some banks answer with an empty list (a wallet's window is far
    /// shorter than the ask) is retried once on the bank's own window.
    /// </summary>
    public async Task<IReadOnlyList<AggregatorTransaction>> TransactionsAsync(HttpClient http, string accountId, DateOnly? from, CancellationToken ct)
    {
        var rows = await PagesAsync(http, accountId, from, ct).ConfigureAwait(false);
        if (from is not null && rows.Count == 0) rows = await PagesAsync(http, accountId, null, ct).ConfigureAwait(false);
        return rows;
    }

    private async Task<List<AggregatorTransaction>> PagesAsync(HttpClient http, string accountId, DateOnly? from, CancellationToken ct)
    {
        var rows = new List<AggregatorTransaction>();
        string? continuation = null;
        for (var page = 0; page < MaxPages; page++)
        {
            var query = new List<string>();
            if (from is { } f) query.Add($"date_from={f:yyyy-MM-dd}");
            if (continuation is not null) query.Add($"continuation_key={Uri.EscapeDataString(continuation)}");
            var path = $"accounts/{Uri.EscapeDataString(accountId)}/transactions{(query.Count > 0 ? "?" + string.Join('&', query) : string.Empty)}";
            var result = await SendAsync<EbTransactions>(http, HttpMethod.Get, path, null, "transactions", true, ct).ConfigureAwait(false);
            rows.AddRange(result.Transactions.Select(Row));
            continuation = result.ContinuationKey;
            if (continuation is null) break;
        }
        return rows;
    }

    // ── mapping ─────────────────────────────────────────────────────────

    private static string MapBalanceType(string? type) => type?.ToUpperInvariant() switch
    {
        "CLBD" => "closingBooked",
        "ITBD" => "interimBooked",
        var other => other ?? string.Empty,
    };

    /// <summary>
    /// Amounts come unsigned with a direction; a debit turns negative. Banks
    /// that omit the reference or the booking day (wallets among them) get a
    /// reference derived from the row's stable facts, so every re-fetch maps
    /// to the same row — the derivation the api used, kept to the byte.
    /// </summary>
    private static AggregatorTransaction Row(EbTransaction tx)
    {
        var debit = string.Equals(tx.CreditDebitIndicator, "DBIT", StringComparison.OrdinalIgnoreCase);
        var amount = debit && !tx.TransactionAmount.Amount.StartsWith('-') ? "-" + tx.TransactionAmount.Amount : tx.TransactionAmount.Amount;
        var bookingDate = tx.BookingDate ?? tx.ValueDate ?? tx.TransactionDate;
        var remittance = tx.RemittanceInformation is { Count: > 0 } lines ? string.Join(' ', lines) : null;
        var reference = string.IsNullOrWhiteSpace(tx.EntryReference)
            ? SyntheticReference(bookingDate, amount, tx, remittance)
            : tx.EntryReference;
        return new AggregatorTransaction
        {
            Reference = reference,
            BookingDate = bookingDate,
            ValueDate = tx.ValueDate,
            Amount = amount,
            Currency = tx.TransactionAmount.Currency,
            CreditorName = tx.Creditor?.Name,
            DebtorName = tx.Debtor?.Name,
            CreditorIban = tx.CreditorAccount?.Iban,
            DebtorIban = tx.DebtorAccount?.Iban,
            Remittance = remittance,
            Pending = string.Equals(tx.Status, "PDNG", StringComparison.OrdinalIgnoreCase),
        };
    }

    private static string SyntheticReference(string? date, string amount, EbTransaction tx, string? remittance)
    {
        var seed = string.Join('|', date, amount, tx.TransactionAmount.Currency,
            tx.Creditor?.Name, tx.Debtor?.Name, tx.CreditorAccount?.Iban, tx.DebtorAccount?.Iban, remittance);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return "eb:" + Convert.ToHexString(hash)[..24].ToLowerInvariant();
    }

    // ── plumbing ────────────────────────────────────────────────────────

    private string Jwt()
    {
        lock (_jwtGate)
        {
            var now = time.GetUtcNow();
            if (_jwt is not null && now < _jwtExpires) return _jwt;
            if (_key is null)
            {
                var rsa = RSA.Create();
                // environment files carry the PEM as one line with \n escapes
                rsa.ImportFromPem((options.PrivateKeyPem ?? string.Empty).Replace("\\n", "\n", StringComparison.Ordinal));
                _key = rsa;
            }
            var header = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new { alg = "RS256", typ = "JWT", kid = options.ApplicationId }));
            var payload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new
            {
                iss = "enablebanking.com",
                aud = "api.enablebanking.com",
                iat = now.ToUnixTimeSeconds(),
                exp = now.AddHours(1).ToUnixTimeSeconds(),
            }));
            var signature = _key.SignData(Encoding.ASCII.GetBytes($"{header}.{payload}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            _jwt = $"{header}.{payload}.{Base64Url(signature)}";
            _jwtExpires = now.AddMinutes(55);
            return _jwt;
        }
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private async Task<HttpResponseMessage> SendAsync(HttpClient http, HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var request = new HttpRequestMessage(method, new Uri(_base, path));
        try
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Jwt());
            if (body is not null) request.Content = JsonContent.Create(body);
            return await ProviderHttp.SendAsync(http, request, ProviderId, ct).ConfigureAwait(false);
        }
        catch
        {
            request.Dispose();
            throw;
        }
    }

    private async Task<T> SendAsync<T>(HttpClient http, HttpMethod method, string path, object? body, string what, bool consentScoped, CancellationToken ct)
    {
        using var response = await SendAsync(http, method, path, body, ct).ConfigureAwait(false);
        await EnsureAsync(response, what, consentScoped, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync<T>(ct).ConfigureAwait(false)
               ?? throw ConnectorException.ProviderChanged($"{ProviderId}: {what} came back empty");
    }

    /// <summary>Enable Banking explains its refusals (inactive application, unregistered redirect, IP allowlist); the text is kept for the operator.</summary>
    private static async Task EnsureAsync(HttpResponseMessage response, string what, bool consentScoped, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        throw Failure(response.StatusCode, what, body, consentScoped);
    }

    private static ConnectorException Failure(HttpStatusCode status, string what, string body, bool consentScoped)
    {
        var code = (int)status;
        var said = body.Length > 200 ? body[..200] : body;
        var detail = $"{ProviderId}: {what} refused with {code}{(said.Length > 0 ? $"; provider said: {said.ReplaceLineEndings(" ")}" : string.Empty)}";
        if (code == 429) return new ConnectorException(ErrorCode.RateLimited, detail);
        if (consentScoped && code is 401 or 403) return new ConnectorException(ErrorCode.ConsentExpired, detail);
        if (code is 401 or 403) return new ConnectorException(ErrorCode.ProviderUnavailable, detail);
        return new ConnectorException(ProviderHttp.Failure(status, ProviderId, what).Code, detail);
    }
}
