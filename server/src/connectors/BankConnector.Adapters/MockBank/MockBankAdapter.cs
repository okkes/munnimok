using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

// offline fixtures: no socket, and never touch Browser even where the manifest declares a browser tier (it is for routing)
// a day's data never moves, so a content hash asserted today holds next year; history ends on the provider's today
public abstract class MockBankAdapter : IProviderAdapter
{
    protected MockBankAdapter(TimeProvider? time = null) => Time = time ?? TimeProvider.System;

    protected TimeProvider Time { get; }

    // the ledger ends on the provider's clock so its history limit is always filled:
    // a fixed last day emptied every window once it fell behind
    protected virtual MockBankLedger LedgerThrough(DateOnly today) => MockBankLedger.Through(today);

    protected DateOnly Today => DateOnly.FromDateTime(Time.GetUtcNow().UtcDateTime);

    // overrides the per-fetch record ceiling; null outside tests, where a small one makes a pass partial on purpose
    public int? RecordCap { get; init; }

    public abstract ProviderManifest Describe();

    public abstract Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct);

    public virtual Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        return Task.FromResult(Serve(ctx, request));
    }

    // a user disconnecting must always succeed locally
    public virtual Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ctx.Progress(JobStep.LoggingOut);
        return Task.CompletedTask;
    }

    protected FetchResult Serve(IJobContext ctx, ResourceRequest request)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        var manifest = Describe();
        // one reading of the clock: the ledger and the window end on the same day
        var today = Today;
        var ledger = LedgerThrough(today);
        var accounts = ledger.ToAccounts(ctx.SessionId);

        ctx.Progress(JobStep.Parsing);

        switch (request.ResourceId)
        {
            case BankResources.Accounts:
                ctx.Progress(JobStep.Normalizing);
                return BankEmission.Verified(manifest.Id, BankAccountFilter.Select(accounts, request), [], via: "fixture");

            case BankResources.Transactions:
            {
                var selected = BankAccountFilter.Select(accounts, request);
                var window = BankWindow.Resolve(request, manifest, today);

                ctx.Progress(JobStep.Normalizing);
                var (page, complete) = Newest(
                    ledger.ToTransactions(ctx.SessionId, selected, window),
                    RecordCap ?? manifest.Resource(BankResources.Transactions)?.MaxRecordsPerFetch ?? 200);

                ctx.Progress(JobStep.Finalizing);
                return BankEmission.Verified(manifest.Id, selected, page, complete, via: "fixture");
            }

            default:
                throw ConnectorException.Unsupported($"{manifest.Id} has no resource '{request.ResourceId}'");
        }
    }

    // the cap is shared out per account, each keeping its newest rows, so a partial page stops on different days per account
    internal static (IReadOnlyList<Transaction> Page, bool Complete) Newest(IReadOnlyList<Transaction> ordered, int cap)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        if (ordered.Count <= cap) return (ordered, true);

        var accounts = ordered.GroupBy(t => t.AccountId, StringComparer.Ordinal).ToList();
        var page = new List<Transaction>(cap);
        for (var i = 0; i < accounts.Count; i++)
        {
            // what is left, divided by the accounts still to come: a quiet account passes its share on
            var budget = Math.Max(1, (cap - page.Count) / (accounts.Count - i));
            var rows = accounts[i].ToList();
            page.AddRange(rows.Skip(Math.Max(0, rows.Count - budget)));
        }

        return (page, page.Count == ordered.Count);
    }

    protected static string RequireInput(IJobContext ctx, string key)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        return ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"login input '{key}' is required");
    }

    protected LoginResult Connected(IJobContext ctx, SessionMaterial material, int ttlSeconds)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        return new LoginResult
        {
            Material = material,
            Account = new ProviderAccount
            {
                DisplayName = MockBankCredentials.AccountLabel,
                ExternalId = MockBankLedger.CurrentIban,
            },
            Reachable = LedgerThrough(Today).Reachable,
            // the real expiry, not the manifest TTL: a longer claim makes the consumer promise syncing it then fails
            ExpiresAt = Time.GetUtcNow().AddSeconds(ttlSeconds),
        };
    }
}

public static class MockBankCredentials
{
    public const string Username = "demo";

    public const string Password = "demo-password";

    // any password is accepted except this one, which fails with InvalidCredentials, a code that must never be retried
#pragma warning disable S2068 // the mock bank's rejected password, not a credential
    public const string RejectedPassword = "invalid";
#pragma warning restore S2068

    public const string DisplayedCode = "84213906";

    // same shape as a Playwright storage state, so a control plane that seals and reopens it exercises the real path
    public const string StorageState = """{"cookies":[{"name":"mock-bank-session","value":"fixture","domain":"mock.invalid","path":"/"}],"origins":[]}""";

    // .invalid is reserved by RFC 2606 and can never be routed
    public const string AccountLabel = "Mock Bank - demo@mock.invalid";
}
