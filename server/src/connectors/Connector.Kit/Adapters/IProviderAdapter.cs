using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace Connector.Kit.Adapters;

// adapters never touch the database, call the consuming app, decide retry policy or emit user-facing prose: platform
// concerns, chiefly that a failed login is never retried
public interface IProviderAdapter
{
    /// <summary>The catalogue entry. Pure; called often; must not do I/O.</summary>
    ProviderManifest Describe();

    Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct);

    // may raise challenges too: a T3 provider re-authenticates on every run
    Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct);

    // an adapter that CANNOT answer falls through to its ordinary sign-in: the default is CannotTell, not "no" (a false
    // "no" re-drives a sign-in the provider counts, on DigiD one Logius scores) or "yes" (a false "yes" reports a
    // connection that does not exist). Asked via SessionProbe.AskAsync, never directly; a positive answer must leave
    // the job requeueable: CredentialSubmitted not latched
    Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct) =>
        Task.FromResult(SessionPresence.CannotTell);

    // best effort: a failure is logged, never fatal; a user disconnecting must always succeed locally
    Task LogoutAsync(IJobContext ctx, CancellationToken ct) => Task.CompletedTask;
}

public interface IJobContext
{
    string SessionId { get; }

    string JobId { get; }

    // secret-tainted: values for fields declared secret are never logged or screenshotted; empty for a fetch
    IReadOnlyDictionary<string, string> Inputs { get; }

    /// <summary>Non-secret provider settings such as country and language.</summary>
    IReadOnlyDictionary<string, string> Config { get; }

    // null on a first login; for an agent-custody provider only a pointer
    SessionMaterial? Material { get; }

    // the politeness limiter is installed: any other client bypasses rate limiting
    HttpClient Http { get; }

    // launched on first access (a T1 adapter never starts one); its navigations are Chromium's socket and skip Http's limiter,
    // so an adapter walking pages in a loop holds a Pacer ticket around each
    IBrowserLease Browser { get; }

    // the pace for work Http's limiter cannot see; default none: a browserless context's HTTP client is already limited
    IProviderPacer Pacer => UnpacedProvider.Instance;

    void Progress(JobStep step);

    // a courtesy like Progress: a lost count never fails a run, and a context with nowhere to write ignores it
    void Found(int records)
    {
    }

    // a line for the operator's log, never a user; a string, not ILogger (this assembly is the dependency-free wire contract),
    // and not a JobStep (a closed translatable vocabulary). Never pass secret-tainted input, a credential or a challenge answer
    void Note(string message)
    {
        // no-op default: a context with nowhere to write is not an error
    }

    // relays a question to the account's owner and waits; throws when the challenge expires unanswered
    Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct);

    // what the party said about its budget (an aggregator's per-account daily allowance from response headers)
    void ReportQuota(ProviderQuota quota)
    {
        // no-op default: the platform keeps it as a fact about the provider
    }

    // after this a lost lease fails the job permanently instead of requeuing:
    // retrying a login that may have counted locks accounts
    void CredentialSubmitted();

    /// <summary>A directory that is deleted when the job ends, including on failure.</summary>
    string WorkDirectory { get; }

    // a human can see and touch the browser (a headed agent at its owner's machine): hCaptcha/reCAPTCHA widgets cannot be
    // relayed as a screenshot, so the owner solves it there or we fail BlockedByProvider. Default false: a datacenter agent
    // has nobody to ask and would hang the job to its budget
    bool Attended => false;

    // the browser starts from something an earlier run left (a kept profile dir, or storage state from the bundle);
    // not a claim anybody is signed in: SessionProbe checks it first, as a browser handed nothing cannot be signed in
    // profile: a BYO agent's; storage state: the pooled fleet's on a refresh (Amazon's refresh skips sign-in that way)
    bool KeepsSession => false;
}

public interface IBrowserLease : IAsyncDisposable
{
    // restores a storage state from the session material when present, so a second run skips login and 2FA
    Task<Microsoft.Playwright.IPage> PageAsync(CancellationToken ct);

    Task<string> StorageStateAsync(CancellationToken ct);

    /// <summary>
    /// A redacted screenshot for a challenge. Refuses to capture while any
    /// secret-declared field holds content.
    /// </summary>
    Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct);

    bool Started { get; }
}

public sealed record LoginResult
{
    public required SessionMaterial Material { get; init; }

    /// <summary>Shown to the user so they can tell two connections apart.</summary>
    public ProviderAccount? Account { get; init; }

    public IReadOnlyList<ReachableAccount> Reachable { get; init; } = [];

    // overrides the manifest's TTL when the provider says more: a manifest claiming 30 days for a 24-hour session promises a
    // month of silent syncing and then fails
    public DateTimeOffset? ExpiresAt { get; init; }
}

public sealed record ProviderAccount
{
    [System.Text.Json.Serialization.JsonPropertyName("display_name")]
    public required string DisplayName { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("external_id")]
    public string? ExternalId { get; init; }
}

public sealed record FetchResult
{
    public IReadOnlyList<Account> Accounts { get; init; } = [];

    public IReadOnlyList<Transaction> Transactions { get; init; } = [];

    public IReadOnlyList<Receipt> Receipts { get; init; } = [];

    // a standing position, not an event: its own list rather than a kind of transaction
    public IReadOnlyList<CreditRegistration> Registrations { get; init; } = [];

    // a standing position whose amount is what is LEFT, the opposite of CreditRegistration.Amount
    public IReadOnlyList<StudentDebt> Debts { get; init; } = [];

    /// <summary>
    /// Refreshed material when the provider rotated a token. Sealed into a
    /// new bundle the caller must persist.
    /// </summary>
    public SessionMaterial? RefreshedMaterial { get; init; }

    // false when more remains beyond this pass: a first connect on a heavy account paginates
    public bool Complete { get; init; } = true;

    // which upstream recipe answered when a provider has more than one: makes the next breakage diagnosable
    public string? Via { get; init; }

    // keyed by external id, only when ResourceRequest.WantsRaw asked; an adapter with nothing meaningful to hand back
    // (a scraped page, a record built from several calls) leaves it empty
    public IReadOnlyDictionary<string, string> Raw { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public int Count =>
        Accounts.Count + Transactions.Count + Receipts.Count + Registrations.Count + Debts.Count;

    public static FetchResult Empty { get; } = new();
}
