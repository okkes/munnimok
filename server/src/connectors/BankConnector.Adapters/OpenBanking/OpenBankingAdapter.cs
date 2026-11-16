using System.Collections.Concurrent;
using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>One institution as an aggregator lists it; <c>MaxConsentDays</c> is the longest consent the bank grants, where the party says.</summary>
public sealed record Institution(string Id, string Name, string? LogoUrl, int? HistoryDays, int? MaxConsentDays = null);

// no browser, no agent: the operator's key in configuration and a consent id in the session
// the two aggregators differ only in their wire, which the abstract members carry
public abstract class OpenBankingAdapter : IProviderAdapter, ILookupProvider
{
    private static readonly TimeSpan InstitutionsFor = TimeSpan.FromHours(24);
    private const int MaxLogoBytes = 1024 * 1024;

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, IReadOnlyList<Institution> List)> _institutions =
        new(StringComparer.Ordinal);

    protected OpenBankingAdapter(TimeProvider? time)
    {
        Time = time ?? TimeProvider.System;
    }

    protected TimeProvider Time { get; }

    public abstract ProviderManifest Describe();

    protected string PartyId => Describe().Id;

    /// <summary>The query key the bank's return carries the reference under (GoCardless <c>ref</c>, Enable Banking <c>state</c>).</summary>
    protected abstract string ReferenceKey { get; }

    protected abstract string ReferencePrefix { get; }

    protected abstract Task<IReadOnlyList<Institution>> InstitutionsAsync(HttpClient http, string country, CancellationToken ct);

    // returns where to send the person, what to complete with, and when the consent asked for ends
    protected abstract Task<(string Url, string PendingId, DateTimeOffset ExpiresAt)> StartConsentAsync(
        HttpClient http, Institution institution, string returnUrl, string reference, int consentDays, CancellationToken ct);

    protected abstract Task<(string ConsentId, IReadOnlyList<string> AccountIds)> CompleteConsentAsync(
        HttpClient http, string pendingId, IReadOnlyDictionary<string, string> landing, CancellationToken ct);

    protected abstract Task<(string? Iban, string? Name, string? Currency, string? Identity)> DetailsAsync(HttpClient http, string accountId, CancellationToken ct);

    /// <summary>The party names an account across consents in its details: a consent read before that was asked gets its details once more.</summary>
    protected virtual bool KnowsIdentity => false;

    /// <summary>
    /// The longest consent the bank grants, up to the 180 days PSD2 allows
    /// (#491: the 90 days asked until now ended a consent the person expected
    /// to last half a year); the old 90 where the party does not say.
    /// </summary>
    internal static int ConsentDaysFor(Institution institution) =>
        institution.MaxConsentDays is { } max and > 0
            ? Math.Min(max, OpenBankingManifests.MaxConsentDays)
            : OpenBankingManifests.ConsentDays;

    protected abstract Task<IReadOnlyList<(string Type, string Amount, string Currency, string? Date)>> BalancesAsync(
        HttpClient http, string accountId, CancellationToken ct);

    // rows up to `to` only when the caller named an end (a backfill pass, #460)
    // Complete is false when the party held more than the walk took
    protected abstract Task<(IReadOnlyList<AggregatorTransaction> Rows, ProviderQuota? Quota, bool Complete)> TransactionsAsync(
        HttpClient http, string accountId, DateOnly from, DateOnly? to, CancellationToken ct);

    protected abstract Task RevokeAsync(HttpClient http, string consentId, CancellationToken ct);

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();
        ctx.Progress(JobStep.OpeningProvider);
        var country = Country(ctx.Inputs.GetValueOrDefault(OpenBankingManifests.CountryField));
        var institutionId = RequireInput(ctx, OpenBankingManifests.InstitutionField);
        var returnUrl = OpenBankingReturn.RequireReturnUrl(ctx, PartyId);
        var institution = await InstitutionAsync(ctx.Http, country, institutionId, ct).ConfigureAwait(false);

        var reference = Ids.New(ReferencePrefix);
        var (url, pendingId, expiresAt) = await StartConsentAsync(ctx.Http, institution, returnUrl, reference, ConsentDaysFor(institution), ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);
        var answer = await ctx.AskAsync(
            OpenBankingReturn.Redirect(url, returnUrl, reference, Time.GetUtcNow().AddMinutes(OpenBankingManifests.RedirectMinutes)),
            ct).ConfigureAwait(false);
        var landing = OpenBankingReturn.RequireReturn(PartyId, answer, reference, ReferenceKey);

        ctx.Progress(JobStep.Authenticating);
        var (consentId, accountIds) = await CompleteConsentAsync(ctx.Http, pendingId, landing, ct).ConfigureAwait(false);
        if (accountIds.Count == 0)
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired, $"{PartyId}: the consent reaches no account");
        }

        ctx.Progress(JobStep.Finalizing);
        var accounts = new List<ConsentAccount>(accountIds.Count);
        foreach (var id in accountIds)
        {
            accounts.Add(await DetailedAsync(ctx, new ConsentAccount { Id = id }, ct).ConfigureAwait(false));
        }
        var consent = new ConsentMaterial
        {
            ConsentId = consentId,
            InstitutionId = institution.Id,
            InstitutionName = institution.Name,
            Country = country,
            Accounts = accounts,
        };
        return new LoginResult
        {
            Material = consent.ToMaterial(),
            Account = new ProviderAccount { DisplayName = institution.Name, ExternalId = consentId },
            Reachable = [.. accounts.Select(a => new ReachableAccount
            {
                ExternalId = a.Id,
                Type = AccountTypes.Wire(a.Iban is null ? AccountType.Unknown : AccountType.Current),
                DisplayName = a.Name ?? a.Iban ?? institution.Name,
            })],
            ExpiresAt = expiresAt,
        };
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);
        var consent = ConsentMaterial.From(ctx.Material, PartyId);
        var today = DateOnly.FromDateTime(Time.GetUtcNow().UtcDateTime);
        ctx.Progress(JobStep.OpeningProvider);
        // an older pass is after transactions only: the party budgets balance reads per account per day, and the regular pass needs them
        var (accounts, refreshed) = await AccountsAsync(ctx, consent, today, balances: request.Until is null, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Parsing);
        var selected = BankAccountFilter.Select(accounts, request);
        switch (request.ResourceId)
        {
            case BankResources.Accounts:
                ctx.Progress(JobStep.Normalizing);
                return BankEmission.Verified(PartyId, selected, [], via: "api", refreshedMaterial: refreshed);
            case BankResources.Transactions:
            {
                var window = BankWindow.Resolve(request, Describe(), today);
                var transactions = new List<Transaction>();
                var complete = true;
                foreach (var account in selected)
                {
                    var (rows, whole) = await RowsAsync(ctx, account, window, request.Until is not null, ct).ConfigureAwait(false);
                    transactions.AddRange(rows);
                    complete &= whole;
                    ctx.Found(transactions.Count);
                }
                ctx.Progress(JobStep.Normalizing);
                var ordered = transactions.OrderBy(t => t.BookedAt).ThenBy(t => t.ExternalId, StringComparer.Ordinal).ToList();
                ctx.Progress(JobStep.Finalizing);
                return BankEmission.Verified(PartyId, selected, ordered, complete: complete, via: "api", refreshedMaterial: refreshed);
            }
            default:
                throw ConnectorException.Unsupported($"{PartyId} has no resource '{request.ResourceId}'");
        }
    }

    /// <summary>Details once per account for the life of the consent (handed back as refreshed material when learned); balances when asked for and the party's budget allows.</summary>
    private async Task<(List<Account> Accounts, SessionMaterial? Refreshed)> AccountsAsync(
        IJobContext ctx, ConsentMaterial consent, DateOnly today, bool balances, CancellationToken ct)
    {
        var learned = false;
        var detailed = new List<ConsentAccount>(consent.Accounts.Count);
        var accounts = new List<Account>(consent.Accounts.Count);
        foreach (var known in consent.Accounts)
        {
            var stale = !known.Detailed || (KnowsIdentity && !known.IdentityRead);
            var account = stale ? await DetailedAsync(ctx, known, ct).ConfigureAwait(false) : known;
            learned |= account != known;
            detailed.Add(account);
            var balance = balances ? await BalanceAsync(ctx, account, today, ct).ConfigureAwait(false) : null;
            accounts.Add(BankRecords.NewAccount(ctx.SessionId, OpenBankingRecords.ToAccount(account, consent, balance)));
        }
        return (accounts, learned ? (consent with { Accounts = detailed }).ToMaterial() : null);
    }

    // a budget refusal gives no balance, a fact about the day not the consent: it once failed the whole pass (prod 2026-10-08)
    // two accounts passes in one minute hit the budget, the session ended, and the transactions were never asked for
    // the account is emitted without a balance: the consumer keeps its last one
    private async Task<Balance?> BalanceAsync(IJobContext ctx, ConsentAccount account, DateOnly today, CancellationToken ct)
    {
        try
        {
            var balances = await BalancesAsync(ctx.Http, account.Id, ct).ConfigureAwait(false);
            return OpenBankingRecords.PickBalance(balances, today);
        }
        catch (ConnectorException ex) when (ex.Code == ErrorCode.RateLimited)
        {
            ctx.Note($"{account.Id}: the party's budget refused the balance for now; the last one known stands");
            return null;
        }
    }

    // a pending row is kept whatever its day, except on a backfill pass (#460), which ends long before today
    private async Task<(List<Transaction> Rows, bool Complete)> RowsAsync(IJobContext ctx, Account account, FetchWindow window, bool backfill, CancellationToken ct)
    {
        var (rows, quota, complete) = await TransactionsAsync(ctx.Http, account.ExternalId, window.From, backfill ? window.To : null, ct).ConfigureAwait(false);
        if (quota is not null) ctx.ReportQuota(quota with { SeenAt = Time.GetUtcNow() });
        if (!complete) ctx.Note($"{account.ExternalId}: the party holds more rows than one walk takes; an older pass asks for the rest");
        var transactions = new List<Transaction>(rows.Count);
        var dropped = 0;
        foreach (var row in rows)
        {
            var draft = OpenBankingRecords.ToDraft(row);
            if (draft is null || ((!row.Pending || backfill) && !window.Contains(draft.BookedAt)))
            {
                dropped++;
                continue;
            }
            transactions.Add(BankRecords.NewTransaction(ctx.SessionId, account.Id, draft));
        }
        if (dropped > 0) ctx.Note($"{account.ExternalId}: {dropped} row(s) without a reference, a day, or outside the window were left out");
        return (transactions, complete);
    }

    public async Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        var consent = ConsentMaterial.From(ctx.Material, PartyId);
        await RevokeAsync(ctx.Http, consent.ConsentId, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<LookupOption>> LookupAsync(HttpClient http, string field, LookupQuery query, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (!string.Equals(field, OpenBankingManifests.InstitutionField, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{PartyId} lists no options for '{field}'");
        }
        var list = await CachedInstitutionsAsync(http, Country(query.Get(OpenBankingManifests.CountryField)), ct).ConfigureAwait(false);
        var text = query.Text.Trim();
        var matching = text.Length == 0
            ? list
            : list.Where(i => i.Name.Contains(text, StringComparison.OrdinalIgnoreCase)).ToList();
        return [.. matching
            .OrderBy(i => i.Name, StringComparer.OrdinalIgnoreCase)
            .Select(i => new LookupOption { Value = i.Id, Label = i.Name, HasLogo = i.LogoUrl is not null })];
    }

    public async Task<LookupLogo?> LookupLogoAsync(HttpClient http, string field, string value, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(http);
        if (!string.Equals(field, OpenBankingManifests.InstitutionField, StringComparison.Ordinal)) return null;
        var institution = _institutions.Values.SelectMany(v => v.List).FirstOrDefault(i => i.Id == value)
                          ?? await InstitutionAsync(http, Country(null), value, ct).ConfigureAwait(false);
        if (institution.LogoUrl is null || !Uri.TryCreate(institution.LogoUrl, UriKind.Absolute, out var url)) return null;
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await ProviderHttp.SendAsync(http, request, PartyId, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return null;
        var type = response.Content.Headers.ContentType?.MediaType;
        if (type is null || !type.StartsWith("image/", StringComparison.Ordinal)) return null;
        if (response.Content.Headers.ContentLength is > MaxLogoBytes) return null;
        var bytes = await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        return bytes.Length is 0 or > MaxLogoBytes ? null : new LookupLogo(bytes, type);
    }

    /// <summary>The account with its details, when the party will say them now; a budget refusal leaves it undetailed for the next fetch.</summary>
    private async Task<ConsentAccount> DetailedAsync(IJobContext ctx, ConsentAccount account, CancellationToken ct)
    {
        try
        {
            var (iban, name, currency, identity) = await DetailsAsync(ctx.Http, account.Id, ct).ConfigureAwait(false);
            return account with { Iban = iban, Name = name, Currency = currency, Identity = identity ?? account.Identity, Detailed = true, IdentityRead = KnowsIdentity };
        }
        catch (ConnectorException ex) when (ex.Code == ErrorCode.RateLimited)
        {
            ctx.Note($"{account.Id}: the party's budget refused the details for now");
            return account;
        }
    }

    private async Task<Institution> InstitutionAsync(HttpClient http, string country, string id, CancellationToken ct)
    {
        var list = await CachedInstitutionsAsync(http, country, ct).ConfigureAwait(false);
        return list.FirstOrDefault(i => string.Equals(i.Id, id, StringComparison.Ordinal))
               ?? throw ConnectorException.InvalidRequest($"{PartyId}: '{id}' is not an institution the party lists for {country}");
    }

    private async Task<IReadOnlyList<Institution>> CachedInstitutionsAsync(HttpClient http, string country, CancellationToken ct)
    {
        var now = Time.GetUtcNow();
        if (_institutions.TryGetValue(country, out var cached) && now - cached.At < InstitutionsFor) return cached.List;
        var fresh = await InstitutionsAsync(http, country, ct).ConfigureAwait(false);
        _institutions[country] = (now, fresh);
        return fresh;
    }

    private static string Country(string? input)
    {
        var country = string.IsNullOrWhiteSpace(input) ? "NL" : input.Trim().ToUpperInvariant();
        return country.Length == 2 && country.All(char.IsAsciiLetterUpper)
            ? country
            : throw ConnectorException.InvalidRequest($"'{input}' is not a two-letter country code");
    }

    private string RequireInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value.Trim()
            : throw ConnectorException.InvalidRequest($"{PartyId}: login input '{key}' is required");
}
