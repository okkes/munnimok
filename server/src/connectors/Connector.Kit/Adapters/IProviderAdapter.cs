using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace Connector.Kit.Adapters;

/// <summary>
/// Everything a provider plugin implements, and the entire surface its
/// author sees.
///
/// Adapters never touch the database, never call the consuming app, never
/// decide retry policy, and never emit user-facing prose. Those are all
/// platform concerns precisely so that an adapter author cannot get them
/// wrong - most importantly the rule that a failed login is never retried.
/// </summary>
public interface IProviderAdapter
{
    /// <summary>The catalogue entry. Pure; called often; must not do I/O.</summary>
    ProviderManifest Describe();

    /// <summary>
    /// Authenticate. May raise challenges via
    /// <see cref="IJobContext.AskAsync"/> as many times as the provider
    /// demands. Returns the material to be sealed into the user's bundle.
    /// </summary>
    Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct);

    /// <summary>
    /// Read one resource. May also raise challenges - a T3 provider
    /// re-authenticates on every run.
    /// </summary>
    Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct);

    /// <summary>
    /// Whether the browser this job was handed is ALREADY signed in, so that
    /// <see cref="LoginAsync"/> need not sign in again.
    /// </summary>
    /// <remarks>
    /// Optional, and the default is <see cref="SessionPresence.CannotTell"/>
    /// rather than "no". The difference is the whole point of the capability
    /// existing at all:
    /// <list type="bullet">
    /// <item>An adapter that CANNOT answer must fall through to its ordinary
    /// sign-in, unchanged, having cost nothing. That is what "cannot tell"
    /// buys, and it is why every provider on this platform is safe on the day
    /// this was added.</item>
    /// <item>An adapter that answers WRONGLY breaks in one of two directions,
    /// and both are worse than not asking. A false "no" drives a full sign-in
    /// at a browser that was already inside - a login attempt the provider
    /// counts, a code texted to somebody who did not need it, and on DigiD an
    /// authentication Logius scores. A false "yes" reports a connection that
    /// does not exist: the session is sealed, the consumer says Connected, and
    /// the first scheduled fetch is handed the sign-in form.</item>
    /// </list>
    /// A default of "no" would look harmless and be the first of those on every
    /// provider that never implements this. A default of "yes" would be the
    /// second. Only "cannot tell" is honest about a question nobody answered.
    /// <para>
    /// NEVER CALLED DIRECTLY. It is asked through
    /// <see cref="SessionProbe.AskAsync(IProviderAdapter, IJobContext, CancellationToken)"/>,
    /// which holds the one rule about WHEN it is worth asking - see
    /// <see cref="IJobContext.KeepsSession"/> - and the two lessons live runs
    /// paid for about how to answer it.
    /// </para>
    /// <para>
    /// A positive answer must leave the job REQUEUEABLE: nothing was submitted
    /// upstream, so <see cref="IJobContext.CredentialSubmitted"/> must not have
    /// been latched on the way to it.
    /// </para>
    /// </remarks>
    Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct) =>
        Task.FromResult(SessionPresence.CannotTell);

    /// <summary>
    /// Best-effort upstream logout. Failure here is logged, never fatal: a
    /// user disconnecting must always succeed locally.
    /// </summary>
    Task LogoutAsync(IJobContext ctx, CancellationToken ct) => Task.CompletedTask;
}

/// <summary>
/// The adapter's window onto the run. Deliberately narrow.
/// </summary>
public interface IJobContext
{
    string SessionId { get; }

    string JobId { get; }

    /// <summary>
    /// Login inputs. Secret-tainted: values for fields declared
    /// <c>secret</c> must never be logged or screenshotted. Empty for a
    /// fetch - a fetch has a session, not a password.
    /// </summary>
    IReadOnlyDictionary<string, string> Inputs { get; }

    /// <summary>Non-secret provider settings such as country and language.</summary>
    IReadOnlyDictionary<string, string> Config { get; }

    /// <summary>
    /// The session material from the user's bundle. Null on a first login.
    /// For an agent-custody provider this is only a pointer.
    /// </summary>
    SessionMaterial? Material { get; }

    /// <summary>
    /// An HTTP client with the politeness limiter already installed. Using
    /// anything else bypasses rate limiting and is a bug.
    /// </summary>
    HttpClient Http { get; }

    /// <summary>
    /// A browser, launched on first access. A T1 adapter never touches this,
    /// so no browser is ever started for it.
    /// </summary>
    /// <remarks>
    /// Nothing this browser fetches is paced by <see cref="Http"/>'s limiter -
    /// a navigation is Chromium's socket and never passes through our handler.
    /// An adapter that walks pages in a loop is responsible for holding a
    /// <see cref="Pacer"/> ticket around each one.
    /// </remarks>
    IBrowserLease Browser { get; }

    /// <summary>
    /// The pace this provider is being called at, for work
    /// <see cref="Http"/>'s limiter cannot see.
    ///
    /// Defaults to no pacing, which is the honest answer for a context with no
    /// browser: its HTTP client is already limited, and pacing it a second time
    /// here would charge two gaps for one request.
    /// </summary>
    IProviderPacer Pacer => UnpacedProvider.Instance;

    /// <summary>Typed progress. The consumer renders and translates it.</summary>
    void Progress(JobStep step);

    /// <summary>
    /// A line for the agent's own log. For an operator, never a user.
    ///
    /// The gap this closes was found the hard way. Amazon's invoice fetch
    /// treats a document it cannot read as an order that has none - correctly,
    /// because failing a fetch of nineteen good receipts over one missing PDF
    /// would be worse - but with no way to say so, "this order has no invoice"
    /// and "every single request failed" arrived looking identical, as an empty
    /// list. Diagnosing it meant reading Postgres and re-deriving the whole
    /// call path by hand.
    /// <para>
    /// Deliberately a string and not an <c>ILogger</c>: this assembly is the
    /// wire contract and is dependency-free beyond the framework, and one
    /// method on the seam is a smaller price than a logging package in it.
    /// Deliberately not a progress step either - <see cref="JobStep"/> is a
    /// closed vocabulary the consumer renders and translates, and this is prose
    /// for whoever is holding the logs.
    /// </para>
    /// <para>
    /// SECRET-TAINTED INPUT IS NEVER PASSED HERE. The same rule as every other
    /// diagnostic on this platform: no field the manifest declares secret, no
    /// credential, no answer to a challenge.
    /// </para>
    /// </summary>
    void Note(string message)
    {
        // A context with nowhere to write is not an error. The default keeps
        // every test double and the inline runner compiling unchanged.
    }

    /// <summary>
    /// Relay a question to the human who owns the account and wait for their
    /// answer. The single call that implements the whole challenge protocol.
    /// Throws when the challenge expires unanswered.
    /// </summary>
    Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct);

    /// <summary>
    /// Report a credential as submitted upstream. After this point a lost
    /// lease fails the job permanently instead of requeuing it, because
    /// retrying a login that may already have counted is how accounts get
    /// locked.
    /// </summary>
    void CredentialSubmitted();

    /// <summary>A directory that is deleted when the job ends, including on failure.</summary>
    string WorkDirectory { get; }

    /// <summary>
    /// True when a human can actually see and touch the browser this job is
    /// driving - a headed agent on hardware its owner is sitting at.
    ///
    /// Some challenges cannot be relayed. An hCaptcha or reCAPTCHA is an
    /// interactive widget, not a picture: it wants drags, tile clicks and a
    /// token minted by its own JavaScript, so a screenshot plus a text box
    /// cannot answer it however faithfully we photograph it. That leaves two
    /// honest paths, and this flag is how an adapter tells them apart - the
    /// owner solves it in the window already open in front of them, or we are
    /// <see cref="Errors.ErrorCode.BlockedByProvider"/> and say so.
    ///
    /// Defaults to false: a pooled agent in a datacenter has nobody to ask,
    /// and assuming otherwise would hang a job until its budget ran out -
    /// which is precisely the failure this was added to fix.
    /// </summary>
    bool Attended => false;

    /// <summary>
    /// True when the browser this job opens starts from something an earlier
    /// run left behind - a profile directory that outlives the job, or a
    /// storage state restored out of the user's bundle.
    ///
    /// It is NOT a claim that anybody is signed in. It is the precondition for
    /// that question being worth asking at all, which is why
    /// <see cref="SessionProbe"/> checks it before touching an adapter's
    /// <see cref="IProviderAdapter.AlreadySignedInAsync"/>: a browser handed
    /// nothing cannot already hold a session, and asking anyway would buy a
    /// guaranteed "no" at the price of a settle window - on every first
    /// connect, which is the run somebody is sitting and watching.
    ///
    /// Both halves are needed and neither is the other. The PROFILE is what a
    /// BYO agent keeps per provider, so the second connect on somebody's own
    /// machine is usually no connect at all. The STORAGE STATE is what the
    /// pooled fleet is handed on a refresh, where there is no profile and the
    /// cookie jar from the bundle is the entire session - Amazon's refresh has
    /// skipped its sign-in that way since before this seam existed, and gating
    /// on the profile alone would have taken that away.
    ///
    /// Defaults to false, which is the honest answer for a context with no
    /// browser at all and for every test double: nothing was kept, so nothing
    /// is claimed.
    /// </summary>
    bool KeepsSession => false;
}

/// <summary>
/// A browser that is only launched if an adapter actually asks for one.
/// </summary>
public interface IBrowserLease : IAsyncDisposable
{
    /// <summary>
    /// The page, launched on first call. Restores a storage state from the
    /// session material when one is present, so a second run skips the full
    /// login and 2FA without any password having been stored.
    /// </summary>
    Task<Microsoft.Playwright.IPage> PageAsync(CancellationToken ct);

    /// <summary>
    /// The current cookies and local storage, for sealing into the bundle.
    /// This is the cheap 80% win of session reuse.
    /// </summary>
    Task<string> StorageStateAsync(CancellationToken ct);

    /// <summary>
    /// A redacted screenshot for a challenge. Refuses to capture while any
    /// secret-declared field holds content.
    /// </summary>
    Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct);

    /// <summary>True when a browser was actually started.</summary>
    bool Started { get; }
}

public sealed record LoginResult
{
    /// <summary>What gets sealed into the user's bundle.</summary>
    public required SessionMaterial Material { get; init; }

    /// <summary>Shown to the user so they can tell two connections apart.</summary>
    public ProviderAccount? Account { get; init; }

    /// <summary>What this session can reach, for cheap discovery later.</summary>
    public IReadOnlyList<ReachableAccount> Reachable { get; init; } = [];

    /// <summary>
    /// Overrides the manifest's TTL when the provider tells us something
    /// more specific. Being honest here matters: a manifest that claims 30
    /// days for a 24-hour session makes the consumer promise a month of
    /// silent syncing and then fail.
    /// </summary>
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

    /// <summary>
    /// What a registry states you owe. A standing position rather than an
    /// event, which is why it is its own list and not a kind of transaction.
    /// </summary>
    public IReadOnlyList<CreditRegistration> Registrations { get; init; } = [];

    /// <summary>
    /// What a student-finance body states is owed. A standing position like a
    /// registration, but not one of those: nobody lent it under a contract
    /// with a start and an end, and its amount is what is LEFT rather than
    /// what was borrowed - the opposite of
    /// <see cref="CreditRegistration.Amount"/>.
    /// </summary>
    public IReadOnlyList<StudentDebt> Debts { get; init; } = [];

    /// <summary>
    /// Refreshed material when the provider rotated a token. Sealed into a
    /// new bundle the caller must persist.
    /// </summary>
    public SessionMaterial? RefreshedMaterial { get; init; }

    /// <summary>
    /// False when more remains beyond this pass. A first connect on a heavy
    /// account paginates rather than running for ten minutes.
    /// </summary>
    public bool Complete { get; init; } = true;

    /// <summary>
    /// Which upstream recipe answered, when a provider has more than one.
    /// The signal that makes the next breakage diagnosable.
    /// </summary>
    public string? Via { get; init; }

    /// <summary>
    /// The provider's own payload for a record, keyed by its external id.
    ///
    /// Populated only when <see cref="ResourceRequest.WantsRaw"/> asked for it.
    /// An adapter that has nothing meaningful to hand back - one that scraped
    /// a page, or built a record from three calls - leaves it empty rather than
    /// inventing a shape, and the caller gets a normalised record with no raw
    /// beside it, which is the honest answer.
    /// </summary>
    public IReadOnlyDictionary<string, string> Raw { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public int Count =>
        Accounts.Count + Transactions.Count + Receipts.Count + Registrations.Count + Debts.Count;

    public static FetchResult Empty { get; } = new();
}
