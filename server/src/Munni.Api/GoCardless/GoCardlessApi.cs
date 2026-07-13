using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Munni.Api.GoCardless;

// GoCardless Bank Account Data API (bankaccountdata.gocardless.com/api/v2).
// Rate limits are ~4 account-API calls per day per account — the fetch
// service schedules exactly 4 and there is no on-demand refresh.

public sealed record GcInstitution(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("bic")] string? Bic,
    [property: JsonPropertyName("transaction_total_days")] string? TransactionTotalDays,
    [property: JsonPropertyName("logo")] string? Logo);

public sealed record GcRequisitionCreated(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("link")] string Link,
    [property: JsonPropertyName("status")] string Status);

public sealed record GcRequisitionStatus(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("accounts")] List<string> Accounts);

public sealed record GcAmount(
    [property: JsonPropertyName("amount")] string Amount,
    [property: JsonPropertyName("currency")] string Currency);

public sealed record GcAccountDetails(
    [property: JsonPropertyName("iban")] string? Iban,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("currency")] string? Currency);

public sealed record GcBalance(
    [property: JsonPropertyName("balanceAmount")] GcAmount BalanceAmount,
    [property: JsonPropertyName("balanceType")] string BalanceType);

public sealed record GcAccountReference(
    [property: JsonPropertyName("iban")] string? Iban);

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

public sealed record GcRequisitionListItem(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("institution_id")] string InstitutionId,
    [property: JsonPropertyName("created")] DateTimeOffset? Created,
    [property: JsonPropertyName("reference")] string? Reference,
    [property: JsonPropertyName("accounts")] List<string> Accounts);

public interface IGoCardlessApi
{
    Task<IReadOnlyList<GcInstitution>> GetInstitutionsAsync(string country, CancellationToken ct = default);
    Task<GcRequisitionCreated> CreateRequisitionAsync(string institutionId, string redirect, string reference, CancellationToken ct = default);
    Task<GcRequisitionStatus> GetRequisitionAsync(string requisitionId, CancellationToken ct = default);
    Task<IReadOnlyList<GcRequisitionListItem>> ListRequisitionsAsync(CancellationToken ct = default);
    Task DeleteRequisitionAsync(string requisitionId, CancellationToken ct = default);
    Task<GcAccountDetails> GetAccountDetailsAsync(string gcAccountId, CancellationToken ct = default);
    Task<IReadOnlyList<GcBalance>> GetBalancesAsync(string gcAccountId, CancellationToken ct = default);
    Task<IReadOnlyList<GcTransaction>> GetTransactionsAsync(string gcAccountId, DateOnly? from, CancellationToken ct = default);
}

public sealed class GoCardlessApi(HttpClient http, IConfiguration config) : IGoCardlessApi
{
    private string? _accessToken;
    private DateTimeOffset _accessExpires = DateTimeOffset.MinValue;
    private readonly SemaphoreSlim _tokenLock = new(1, 1);

    private sealed record TokenResponse(
        [property: JsonPropertyName("access")] string Access,
        [property: JsonPropertyName("access_expires")] int AccessExpires);

    private async Task<string> GetTokenAsync(CancellationToken ct)
    {
        if (_accessToken is not null && DateTimeOffset.UtcNow < _accessExpires) return _accessToken;
        await _tokenLock.WaitAsync(ct);
        try
        {
            if (_accessToken is not null && DateTimeOffset.UtcNow < _accessExpires) return _accessToken;
            var response = await http.PostAsJsonAsync("token/new/", new
            {
                secret_id = config["GoCardless:SecretId"],
                secret_key = config["GoCardless:SecretKey"],
            }, ct);
            response.EnsureSuccessStatusCode();
            var token = (await response.Content.ReadFromJsonAsync<TokenResponse>(ct))!;
            _accessToken = token.Access;
            _accessExpires = DateTimeOffset.UtcNow.AddSeconds(token.AccessExpires - 60);
            return _accessToken;
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    private async Task<T> GetAsync<T>(string path, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new("Bearer", await GetTokenAsync(ct));
        var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<T>(ct))!;
    }

    public Task<IReadOnlyList<GcInstitution>> GetInstitutionsAsync(string country, CancellationToken ct = default) =>
        GetAsync<IReadOnlyList<GcInstitution>>($"institutions/?country={Uri.EscapeDataString(country)}", ct);

    public async Task<GcRequisitionCreated> CreateRequisitionAsync(string institutionId, string redirect, string reference, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "requisitions/")
        {
            Content = JsonContent.Create(new { redirect, institution_id = institutionId, reference }),
        };
        request.Headers.Authorization = new("Bearer", await GetTokenAsync(ct));
        var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<GcRequisitionCreated>(ct))!;
    }

    public Task<GcRequisitionStatus> GetRequisitionAsync(string requisitionId, CancellationToken ct = default) =>
        GetAsync<GcRequisitionStatus>($"requisitions/{requisitionId}/", ct);

    private sealed record RequisitionList([property: JsonPropertyName("results")] List<GcRequisitionListItem> Results);

    public async Task<IReadOnlyList<GcRequisitionListItem>> ListRequisitionsAsync(CancellationToken ct = default) =>
        (await GetAsync<RequisitionList>("requisitions/?limit=100", ct)).Results;

    public async Task DeleteRequisitionAsync(string requisitionId, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, $"requisitions/{requisitionId}/");
        request.Headers.Authorization = new("Bearer", await GetTokenAsync(ct));
        var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
    }

    private sealed record DetailsEnvelope([property: JsonPropertyName("account")] GcAccountDetails Account);

    public async Task<GcAccountDetails> GetAccountDetailsAsync(string gcAccountId, CancellationToken ct = default) =>
        (await GetAsync<DetailsEnvelope>($"accounts/{gcAccountId}/details/", ct)).Account;

    private sealed record BalancesEnvelope([property: JsonPropertyName("balances")] List<GcBalance> Balances);

    public async Task<IReadOnlyList<GcBalance>> GetBalancesAsync(string gcAccountId, CancellationToken ct = default) =>
        (await GetAsync<BalancesEnvelope>($"accounts/{gcAccountId}/balances/", ct)).Balances;

    private sealed record TxList([property: JsonPropertyName("booked")] List<GcTransaction> Booked);
    private sealed record TxEnvelope([property: JsonPropertyName("transactions")] TxList Transactions);

    public async Task<IReadOnlyList<GcTransaction>> GetTransactionsAsync(string gcAccountId, DateOnly? from, CancellationToken ct = default)
    {
        var query = from is null ? "" : $"?date_from={from:yyyy-MM-dd}";
        return (await GetAsync<TxEnvelope>($"accounts/{gcAccountId}/transactions/{query}", ct)).Transactions.Booked;
    }
}
