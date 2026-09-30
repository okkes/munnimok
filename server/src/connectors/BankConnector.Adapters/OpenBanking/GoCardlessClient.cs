using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// GoCardless Bank Account Data (<c>bankaccountdata.gocardless.com/api/v2</c>),
/// as the api once spoke it: a bearer token minted from the operator's secret
/// pair and cached until a minute before it expires, an end-user agreement
/// for deep history when the institution offers it, and the per-account
/// daily budget read back from the response headers.
/// </summary>
internal sealed class GoCardlessClient(GoCardlessOptions options, TimeProvider time)
{
    private const string ProviderId = GoCardlessAdapter.ProviderId;

    private readonly Uri _base = new(options.BaseUrl.EndsWith('/') ? options.BaseUrl : options.BaseUrl + "/", UriKind.Absolute);
    private readonly SemaphoreSlim _tokenGate = new(1, 1);
    private string? _token;
    private DateTimeOffset _tokenExpires = DateTimeOffset.MinValue;

    // ── wire shapes ─────────────────────────────────────────────────────

    public sealed record GcInstitution(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("transaction_total_days")] string? TransactionTotalDays,
        [property: JsonPropertyName("logo")] string? Logo);

    public sealed record GcRequisitionCreated(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("link")] string Link,
        [property: JsonPropertyName("status")] string Status);

    public sealed record GcRequisition(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("accounts")] List<string>? Accounts,
        [property: JsonPropertyName("institution_id")] string? InstitutionId = null,
        [property: JsonPropertyName("created")] DateTimeOffset? Created = null,
        [property: JsonPropertyName("reference")] string? Reference = null,
        [property: JsonPropertyName("redirect")] string? Redirect = null);

    public sealed record GcAmount(
        [property: JsonPropertyName("amount")] string Amount,
        [property: JsonPropertyName("currency")] string Currency);

    public sealed record GcAccountDetails(
        [property: JsonPropertyName("iban")] string? Iban,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("currency")] string? Currency,
        [property: JsonPropertyName("ownerName")] string? OwnerName = null);

    public sealed record GcBalance(
        [property: JsonPropertyName("balanceAmount")] GcAmount BalanceAmount,
        [property: JsonPropertyName("balanceType")] string BalanceType,
        [property: JsonPropertyName("referenceDate")] string? ReferenceDate = null);

    public sealed record GcAccountReference([property: JsonPropertyName("iban")] string? Iban);

    public sealed record GcTransaction(
        [property: JsonPropertyName("transactionId")] string? TransactionId,
        [property: JsonPropertyName("internalTransactionId")] string? InternalTransactionId,
        [property: JsonPropertyName("bookingDate")] string? BookingDate,
        [property: JsonPropertyName("valueDate")] string? ValueDate,
        [property: JsonPropertyName("transactionAmount")] GcAmount TransactionAmount,
        [property: JsonPropertyName("creditorName")] string? CreditorName,
        [property: JsonPropertyName("debtorName")] string? DebtorName,
        [property: JsonPropertyName("remittanceInformationUnstructured")] string? RemittanceInformationUnstructured,
        [property: JsonPropertyName("creditorAccount")] GcAccountReference? CreditorAccount = null,
        [property: JsonPropertyName("debtorAccount")] GcAccountReference? DebtorAccount = null);

    private sealed record TokenResponse(
        [property: JsonPropertyName("access")] string Access,
        [property: JsonPropertyName("access_expires")] int AccessExpires);

    private sealed record AgreementCreated([property: JsonPropertyName("id")] string Id);

    private sealed record RequisitionList([property: JsonPropertyName("results")] List<GcRequisition> Results);

    private sealed record DetailsEnvelope([property: JsonPropertyName("account")] GcAccountDetails Account);

    private sealed record BalancesEnvelope([property: JsonPropertyName("balances")] List<GcBalance> Balances);

    private sealed record TxList(
        [property: JsonPropertyName("booked")] List<GcTransaction> Booked,
        [property: JsonPropertyName("pending")] List<GcTransaction>? Pending);

    private sealed record TxEnvelope([property: JsonPropertyName("transactions")] TxList Transactions);

    // ── calls ───────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<GcInstitution>> InstitutionsAsync(HttpClient http, string country, CancellationToken ct) =>
        await GetAsync<List<GcInstitution>>(http, $"institutions/?country={Uri.EscapeDataString(country)}", "institutions", ct).ConfigureAwait(false);

    public Task<GcInstitution> InstitutionAsync(HttpClient http, string id, CancellationToken ct) =>
        GetAsync<GcInstitution>(http, $"institutions/{Uri.EscapeDataString(id)}/", "institution", ct);

    /// <summary>Best effort: a refused agreement must never block the consent — the default 90 days still work.</summary>
    public async Task<string?> AgreementAsync(HttpClient http, string institutionId, int days, CancellationToken ct)
    {
        try
        {
            var created = await PostAsync<AgreementCreated>(http, "agreements/enduser/",
                new { institution_id = institutionId, max_historical_days = days }, "agreement", ct).ConfigureAwait(false);
            return created.Id;
        }
        catch (ConnectorException)
        {
            return null;
        }
    }

    public Task<GcRequisitionCreated> CreateRequisitionAsync(
        HttpClient http, string institutionId, string redirect, string reference, string? agreementId, CancellationToken ct) =>
        PostAsync<GcRequisitionCreated>(http, "requisitions/", agreementId is null
            ? new { redirect, institution_id = institutionId, reference }
            : (object)new { redirect, institution_id = institutionId, reference, agreement = agreementId }, "requisition", ct);

    public Task<GcRequisition> RequisitionAsync(HttpClient http, string id, CancellationToken ct) =>
        GetAsync<GcRequisition>(http, $"requisitions/{Uri.EscapeDataString(id)}/", "requisition", ct);

    public async Task<IReadOnlyList<GcRequisition>> ListRequisitionsAsync(HttpClient http, CancellationToken ct) =>
        (await GetAsync<RequisitionList>(http, "requisitions/?limit=100", "requisitions", ct).ConfigureAwait(false)).Results;

    public async Task DeleteRequisitionAsync(HttpClient http, string id, CancellationToken ct)
    {
        using var response = await SendAsync(http, HttpMethod.Delete, $"requisitions/{Uri.EscapeDataString(id)}/", null, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound) return;   // already gone is the goal state
        await EnsureAsync(response, "revoke", consentScoped: true, ct).ConfigureAwait(false);
    }

    public async Task<GcAccountDetails> DetailsAsync(HttpClient http, string accountId, CancellationToken ct) =>
        (await GetAsync<DetailsEnvelope>(http, $"accounts/{Uri.EscapeDataString(accountId)}/details/", "account details", ct).ConfigureAwait(false)).Account;

    public async Task<IReadOnlyList<GcBalance>> BalancesAsync(HttpClient http, string accountId, CancellationToken ct) =>
        (await GetAsync<BalancesEnvelope>(http, $"accounts/{Uri.EscapeDataString(accountId)}/balances/", "balances", ct).ConfigureAwait(false)).Balances;

    public async Task<(IReadOnlyList<GcTransaction> Booked, IReadOnlyList<GcTransaction> Pending, ProviderQuota? Quota)> TransactionsAsync(
        HttpClient http, string accountId, DateOnly? from, CancellationToken ct)
    {
        var query = from is null ? string.Empty : $"?date_from={from:yyyy-MM-dd}";
        using var response = await SendAsync(http, HttpMethod.Get, $"accounts/{Uri.EscapeDataString(accountId)}/transactions/{query}", null, ct).ConfigureAwait(false);
        var quota = Quota(response.Headers);
        await EnsureAsync(response, "transactions", consentScoped: true, ct).ConfigureAwait(false);
        var envelope = await response.Content.ReadFromJsonAsync<TxEnvelope>(ct).ConfigureAwait(false)
                       ?? throw ConnectorException.ProviderChanged($"{ProviderId}: transactions came back empty");
        return (envelope.Transactions.Booked, envelope.Transactions.Pending ?? [], quota);
    }

    // ── plumbing ────────────────────────────────────────────────────────

    private async Task<string> TokenAsync(HttpClient http, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (_token is not null && now < _tokenExpires) return _token;
        await _tokenGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            now = time.GetUtcNow();
            if (_token is not null && now < _tokenExpires) return _token;
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(_base, "token/new/"))
            {
                Content = JsonContent.Create(new { secret_id = options.SecretId, secret_key = options.SecretKey }),
            };
            using var response = await ProviderHttp.SendAsync(http, request, ProviderId, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                // the operator's pair, not a person's consent: never a sign-in problem for the user
                throw new ConnectorException(ErrorCode.ProviderUnavailable,
                    $"{ProviderId}: the operator credentials were refused with {(int)response.StatusCode}");
            }
            var token = await response.Content.ReadFromJsonAsync<TokenResponse>(ct).ConfigureAwait(false)
                        ?? throw ConnectorException.ProviderChanged($"{ProviderId}: the token endpoint answered nothing");
            _token = token.Access;
            _tokenExpires = now.AddSeconds(Math.Max(60, token.AccessExpires - 60));
            return _token;
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    private async Task<HttpResponseMessage> SendAsync(HttpClient http, HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var request = new HttpRequestMessage(method, new Uri(_base, path));
        try
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await TokenAsync(http, ct).ConfigureAwait(false));
            if (body is not null) request.Content = JsonContent.Create(body);
            return await ProviderHttp.SendAsync(http, request, ProviderId, ct).ConfigureAwait(false);
        }
        catch
        {
            request.Dispose();
            throw;
        }
    }

    private async Task<T> GetAsync<T>(HttpClient http, string path, string what, CancellationToken ct)
    {
        using var response = await SendAsync(http, HttpMethod.Get, path, null, ct).ConfigureAwait(false);
        await EnsureAsync(response, what, consentScoped: path.StartsWith("accounts/", StringComparison.Ordinal) || path.StartsWith("requisitions/", StringComparison.Ordinal), ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync<T>(ct).ConfigureAwait(false)
               ?? throw ConnectorException.ProviderChanged($"{ProviderId}: {what} came back empty");
    }

    private async Task<T> PostAsync<T>(HttpClient http, string path, object body, string what, CancellationToken ct)
    {
        using var response = await SendAsync(http, HttpMethod.Post, path, body, ct).ConfigureAwait(false);
        await EnsureAsync(response, what, consentScoped: false, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync<T>(ct).ConfigureAwait(false)
               ?? throw ConnectorException.ProviderChanged($"{ProviderId}: {what} came back empty");
    }

    /// <summary>
    /// A consent-scoped call refused with 401/403 means the consent ended
    /// (expired agreement, revoked at the bank) — the person consents again;
    /// 429 carries the budget's reset as the retry.
    /// </summary>
    private static async Task EnsureAsync(HttpResponseMessage response, string what, bool consentScoped, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var code = (int)response.StatusCode;
        if (code == 429)
        {
            throw new ConnectorException(ErrorCode.RateLimited, $"{ProviderId}: {what} rate limited")
            {
                RetryAfterSeconds = RetryAfter(response.Headers),
            };
        }
        if (consentScoped && code is 401 or 403)
        {
            throw new ConnectorException(ErrorCode.ConsentExpired, $"{ProviderId}: {what} refused with {code} - the consent no longer grants access");
        }
        await ProviderHttp.EnsureSuccessAsync(response, ProviderId, what, null, ct).ConfigureAwait(false);
    }

    private static int? RetryAfter(HttpResponseHeaders headers)
    {
        if (headers.RetryAfter?.Delta is { } delta) return (int)Math.Ceiling(delta.TotalSeconds);
        return Header(headers, "x-ratelimit-account-success-reset", "http_x_ratelimit_account_success_reset");
    }

    /// <summary>GoCardless announces the per-account daily budget in response headers; both spellings its documentation uses are tried.</summary>
    private ProviderQuota? Quota(HttpResponseHeaders headers)
    {
        var limit = Header(headers, "x-ratelimit-account-success-limit", "http_x_ratelimit_account_success_limit");
        var remaining = Header(headers, "x-ratelimit-account-success-remaining", "http_x_ratelimit_account_success_remaining");
        var reset = Header(headers, "x-ratelimit-account-success-reset", "http_x_ratelimit_account_success_reset");
        if (limit is null && remaining is null && reset is null) return null;
        return new ProviderQuota { Limit = limit, Remaining = remaining, ResetAt = reset is null ? null : time.GetUtcNow().AddSeconds(reset.Value) };
    }

    private static int? Header(HttpResponseHeaders headers, params string[] names)
    {
        foreach (var name in names)
        {
            if (headers.TryGetValues(name, out var values) && int.TryParse(values.FirstOrDefault(), out var n)) return n;
        }
        return null;
    }
}
