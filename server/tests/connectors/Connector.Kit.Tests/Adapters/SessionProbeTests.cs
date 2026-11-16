using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Xunit;

namespace Connector.Kit.Tests;

// a wrong answer is worse than none: a false "no" drives a full sign-in at a signed-in browser (a counted login attempt,
// an SMS code, on DigiD an authentication Logius scores); a false "yes" seals a session that does not exist
// so the default is CannotTell
public sealed class SessionProbeTests
{
    // zero is CannotTell on purpose: a default(SessionPresence) must change nothing, SignedIn on zero would make
    // every unset one skip sign-ins
    [Fact]
    public void The_answer_nobody_gave_is_cannot_tell()
    {
        Assert.Equal(SessionPresence.CannotTell, default);
        Assert.Equal(0, (int)SessionPresence.CannotTell);
    }

    // an adapter implementing nothing says CannotTell, not no: safe to add to a frozen contract, and a "no" would
    // claim something about a provider nobody asked
    [Fact]
    public async Task An_adapter_that_cannot_answer_says_so()
    {
        var answer = await SessionProbe.AskAsync(
            new SilentAdapter(), new Ctx { KeepsSession = true }, CancellationToken.None);

        Assert.Equal(SessionPresence.CannotTell, answer);
    }

    // not asked when nothing could hold a session (no kept profile, no storage state): asking costs a navigation
    // and a settle window on every first connect
    [Fact]
    public async Task A_browser_that_was_handed_nothing_is_never_asked()
    {
        var adapter = new InsideAdapter();

        var answer = await SessionProbe.AskAsync(
            adapter, new Ctx { KeepsSession = false }, CancellationToken.None);

        Assert.Equal(SessionPresence.CannotTell, answer);
        Assert.Equal(0, adapter.Asked);
    }

    [Fact]
    public async Task A_browser_that_kept_something_is_asked_once()
    {
        var adapter = new InsideAdapter();

        var answer = await SessionProbe.AskAsync(
            adapter, new Ctx { KeepsSession = true }, CancellationToken.None);

        Assert.Equal(SessionPresence.SignedIn, answer);
        Assert.Equal(1, adapter.Asked);
    }

    private static readonly DateTimeOffset Now = new(2026, 9, 21, 9, 0, 0, TimeSpan.Zero);

    private const string Portal = "https://provider.test/account/overview";

    private const string SignIn = "https://provider.test/login";

    // a page already on the sign-in address is signed out, no confirmation needed (on DUO a call from inside
    // the SAML chain returns a login page)
    [Fact]
    public async Task A_page_that_says_no_is_signed_out_and_costs_no_confirmation()
    {
        var confirmations = 0;

        var answer = await SessionProbe.OnPageAsync(
            new StubPage { Url = SignIn },
            url => url.Contains("/login", StringComparison.Ordinal),
            _ =>
            {
                confirmations++;
                return Task.FromResult(true);
            },
            TimeSpan.FromSeconds(10),
            TimeSpan.FromMilliseconds(500),
            new InstantTimeProvider(Now),
            CancellationToken.None);

        Assert.Equal(SessionPresence.SignedOut, answer);
        Assert.Equal(0, confirmations);
    }

    // a refusal that lands part way through the window is believed then, not at its end; the wait count tells which happened
    [Fact]
    public async Task A_refusal_part_way_through_the_window_ends_it_there()
    {
        var clock = new InstantTimeProvider(Now);
        var page = new StubPage { Url = Portal };

        page.MovesTo(SignIn, afterReads: 3);

        var answer = await SessionProbe.OnPageAsync(
            page,
            url => url.Contains("/login", StringComparison.Ordinal),
            _ => Task.FromResult(true),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromMilliseconds(500),
            clock,
            CancellationToken.None);

        Assert.Equal(SessionPresence.SignedOut, answer);
        Assert.Equal(4, page.Reads);
        Assert.Equal(3, clock.Waits);
    }

    // ASN answered its overview for a signed-out browser (2026-09-19) and bounced to /inloggen/ a moment later; DUO lands
    // on /particulier/portaal/ and enters SAML afterwards: reading the address once on return is wrong, so the window is watched
    [Fact]
    public async Task A_page_that_never_refuses_is_watched_for_the_whole_window()
    {
        var page = new StubPage { Url = Portal };

        var answer = await SessionProbe.OnPageAsync(
            page,
            url => url.Contains("/login", StringComparison.Ordinal),
            _ => Task.FromResult(true),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromMilliseconds(500),
            new InstantTimeProvider(Now),
            CancellationToken.None);

        Assert.Equal(SessionPresence.SignedIn, answer);
        Assert.Equal(20, page.Reads);
    }

    // not refusing is not confirming: a page that sat on an address and failed its confirmation told us nothing
    // (CannotTell); only a refusal is SignedOut
    [Fact]
    public async Task A_page_that_neither_refuses_nor_confirms_cannot_tell()
    {
        var answer = await SessionProbe.OnPageAsync(
            new StubPage { Url = Portal },
            url => url.Contains("/login", StringComparison.Ordinal),
            _ => Task.FromResult(false),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromMilliseconds(500),
            new InstantTimeProvider(Now),
            CancellationToken.None);

        Assert.Equal(SessionPresence.CannotTell, answer);
    }

    // the address is read before the first delay too: a redirect during the navigation itself must not wait out the window
    [Fact]
    public async Task A_browser_already_on_the_sign_in_page_waits_for_nothing()
    {
        var clock = new InstantTimeProvider(Now);
        var page = new StubPage { Url = SignIn };

        await SessionProbe.OnPageAsync(
            page,
            url => url.Contains("/login", StringComparison.Ordinal),
            _ => Task.FromResult(true),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromMilliseconds(500),
            clock,
            CancellationToken.None);

        Assert.Equal(1, page.Reads);

        // not one wait: reading the address once is not reading it first
        Assert.Equal(0, clock.Waits);
    }

    private sealed class SilentAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => Make.Manifest();

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new InvalidOperationException("this test must not drive a sign-in");

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new InvalidOperationException("this test must not drive a fetch");
    }

    private sealed class InsideAdapter : IProviderAdapter
    {
        public int Asked { get; private set; }

        public ProviderManifest Describe() => Make.Manifest();

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new InvalidOperationException("this test must not drive a sign-in");

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new InvalidOperationException("this test must not drive a fetch");

        public Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
        {
            Asked++;
            return Task.FromResult(SessionPresence.SignedIn);
        }
    }

    // answers only what the gate reads off a context: a wider double would let a test assert through a surface
    // the probe may not use
    private sealed class Ctx : IJobContext
    {
        public string SessionId => Make.SessionId;

        public string JobId => "job_0123456789abcdef0123456789abcdef";

        public IReadOnlyDictionary<string, string> Inputs { get; } =
            new Dictionary<string, string>(StringComparer.Ordinal);

        public IReadOnlyDictionary<string, string> Config { get; } =
            new Dictionary<string, string>(StringComparer.Ordinal);

        public SessionMaterial? Material => null;

        public HttpClient Http => throw new InvalidOperationException("this test makes no request");

        public IBrowserLease Browser => throw new InvalidOperationException("this test starts no browser");

        public string WorkDirectory => throw new InvalidOperationException("this test writes nothing");

        public bool KeepsSession { get; init; }

        public void Progress(JobStep step)
        {
        }

        public Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct) =>
            throw new InvalidOperationException("this test asks nobody anything");

        public void CredentialSubmitted() =>
            throw new InvalidOperationException("nothing here submits a credential");
    }

    private sealed class StubPage : ILoginPage
    {
        private string _url = string.Empty;
        private string? _moveTo;
        private int _moveAfter;

        public int Reads { get; private set; }

        public string Url
        {
            get
            {
                Reads++;

                if (_moveTo is { } destination && Reads > _moveAfter)
                {
                    _url = destination;
                    _moveTo = null;
                }

                return _url;
            }

            init => _url = value;
        }

        // ASN's overview bounced to sign-in a moment after answering (2026-09-19): a fixture whose address cannot change
        // cannot tell that from never bouncing
        public void MovesTo(string url, int afterReads)
        {
            _moveTo = url;
            _moveAfter = afterReads;
        }

        public Task GotoAsync(string url, CancellationToken ct) =>
            throw new InvalidOperationException("the check navigates nowhere of its own");

        public Task ClearSecretsAsync(CancellationToken ct) => Task.CompletedTask;

        public Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
            Task.FromResult<PageMatch?>(null);

        public Task<bool> FillAsync(
            IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
            throw new InvalidOperationException("the check types nothing");

        public Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
            throw new InvalidOperationException("the check presses nothing");

        public Task<bool> AnswerAsync(
            IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
            throw new InvalidOperationException("the check answers nothing");
    }

    // frozen clock, timers fire at once: safe only because the loop is bounded by a count
    // (a deadline from a frozen GetUtcNow would spin); the callback is queued, not run inside CreateTimer:
    // completing Task.Delay from inside its own construction is re-entrancy
    private sealed class InstantTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private int _waits;

        // the only way to say a window was spent, not merely counted
        public int Waits => Volatile.Read(ref _waits);

        public override DateTimeOffset GetUtcNow() => now;

        public override ITimer CreateTimer(
            TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            Interlocked.Increment(ref _waits);

            return new AtOnce(callback, state);
        }

        private sealed class AtOnce : ITimer
        {
            private readonly TimerCallback _callback;
            private readonly object? _state;
            private int _disposed;

            public AtOnce(TimerCallback callback, object? state)
            {
                _callback = callback;
                _state = state;

                Fire();
            }

            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                Fire();
                return true;
            }

            public void Dispose() => Volatile.Write(ref _disposed, 1);

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }

            private void Fire() =>
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    if (Volatile.Read(ref _disposed) == 1) return;
                    _callback(_state);
                });
        }
    }
}
