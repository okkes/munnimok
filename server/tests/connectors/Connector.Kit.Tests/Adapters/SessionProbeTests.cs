using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Xunit;

namespace Connector.Kit.Tests;

/// <summary>
/// "Is this browser already signed in?" - the one place it is asked, and the
/// two things that must never go wrong with it.
///
/// <para>
/// A wrong answer here is worse than no answer, in both directions. A false
/// "no" drives a whole sign-in at a browser that was already inside: a login
/// attempt the provider counts, a code texted to somebody who did not need it,
/// and on DigiD an authentication Logius scores. A false "yes" seals a session
/// that does not exist: the consumer says Connected and the first scheduled
/// fetch is handed the sign-in form.
/// </para>
///
/// <para>
/// So the default is neither, and the question is only asked when it has two
/// possible answers.
/// </para>
/// </summary>
public sealed class SessionProbeTests
{
    /// <summary>
    /// ZERO IS "CANNOT TELL", and that is load-bearing rather than tidy.
    /// </summary>
    /// <remarks>
    /// A <c>default</c> of this enum - a field nobody set, a record built with
    /// the property left off, a double returning <c>default</c> - is then the
    /// answer that changes nothing. Reorder the members so <c>SignedIn</c>
    /// lands on zero and every one of those quietly starts skipping sign-ins.
    /// </remarks>
    [Fact]
    public void The_answer_nobody_gave_is_cannot_tell()
    {
        Assert.Equal(SessionPresence.CannotTell, default);
        Assert.Equal(0, (int)SessionPresence.CannotTell);
    }

    /// <summary>
    /// AN ADAPTER THAT IMPLEMENTS NOTHING SAYS "CANNOT TELL", not "no".
    /// </summary>
    /// <remarks>
    /// The default that makes the capability safe to add to a frozen contract:
    /// every provider that never implements it falls through to its ordinary
    /// sign-in, unchanged, having cost nothing. A default of "no" would look
    /// identical today and would be a claim about a provider nobody asked.
    /// </remarks>
    [Fact]
    public async Task An_adapter_that_cannot_answer_says_so()
    {
        var answer = await SessionProbe.AskAsync(
            new SilentAdapter(), new Ctx { KeepsSession = true }, CancellationToken.None);

        Assert.Equal(SessionPresence.CannotTell, answer);
    }

    /// <summary>
    /// AND THE QUESTION IS NOT ASKED AT ALL WHEN NOTHING COULD BE HOLDING A
    /// SESSION.
    /// </summary>
    /// <remarks>
    /// A browser opened with no kept profile and no storage state out of the
    /// bundle starts from nothing, so the question has exactly one possible
    /// answer - and asking it anyway costs a provider a navigation and the
    /// caller a settle window, on every first connect, which is the one run
    /// somebody is sitting and watching.
    /// <para>
    /// The adapter here would answer <c>SignedIn</c> if it were asked, so the
    /// assertion is not merely about the value that comes back: it is that the
    /// adapter was never reached.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_browser_that_was_handed_nothing_is_never_asked()
    {
        var adapter = new InsideAdapter();

        var answer = await SessionProbe.AskAsync(
            adapter, new Ctx { KeepsSession = false }, CancellationToken.None);

        Assert.Equal(SessionPresence.CannotTell, answer);
        Assert.Equal(0, adapter.Asked);
    }

    /// <summary>
    /// And with something kept, the same adapter is asked exactly once and its
    /// answer is passed straight through.
    /// </summary>
    [Fact]
    public async Task A_browser_that_kept_something_is_asked_once()
    {
        var adapter = new InsideAdapter();

        var answer = await SessionProbe.AskAsync(
            adapter, new Ctx { KeepsSession = true }, CancellationToken.None);

        Assert.Equal(SessionPresence.SignedIn, answer);
        Assert.Equal(1, adapter.Asked);
    }

    // ---- the two lessons, on a page whose answer is its address -------------

    private static readonly DateTimeOffset Now = new(2026, 9, 21, 9, 0, 0, TimeSpan.Zero);

    private const string Portal = "https://provider.test/account/overview";

    private const string SignIn = "https://provider.test/login";

    /// <summary>
    /// A PAGE THAT HAS ALREADY REFUSED ANSWERS AT ONCE AND IS NEVER CONFIRMED.
    /// </summary>
    /// <remarks>
    /// The cheap half of the answer. A browser sitting on the sign-in address
    /// is signed out, full stop, and nothing further need be asked of the
    /// provider - which matters beyond speed on DUO, where a call made from
    /// inside the SAML chain comes back as a login page and reads in the log as
    /// a session that just died.
    /// </remarks>
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

    /// <summary>
    /// A page whose refusal arrives PART WAY THROUGH the window is believed
    /// then, not at the end of it.
    /// </summary>
    /// <remarks>
    /// The shape the window exists for - the bounce that lands a moment after
    /// the navigation returned - and the one that separates watching the
    /// address from waiting out a timer and reading it once. Both answer
    /// <c>SignedOut</c>; only the number of waits says which happened.
    /// </remarks>
    [Fact]
    public async Task A_refusal_part_way_through_the_window_ends_it_there()
    {
        var clock = new InstantTimeProvider(Now);
        var page = new StubPage { Url = Portal };

        // The bounce lands on the fourth look, which is three waits in.
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

    /// <summary>
    /// A PAGE THAT NEVER REFUSES IS GIVEN THE WHOLE WINDOW BEFORE ANYTHING
    /// POSITIVE IS BELIEVED.
    /// </summary>
    /// <remarks>
    /// THE LESSON A LIVE RUN PAID FOR, and it has now been paid twice. ASN
    /// answered its OVERVIEW address for a signed-out browser on 2026-09-19 -
    /// with a profile menu drawn on the page - and bounced to <c>/inloggen/</c>
    /// only a moment later; DUO's portal lands on a <c>/particulier/portaal/</c>
    /// address and enters SAML afterwards. Reading the address the instant a
    /// navigation returns told a user "nothing was asked of you" about a
    /// browser that was signed out.
    /// <para>
    /// So the count is the assertion. Twenty looks at half a second over ten
    /// seconds: a check that read the address once and believed it would pass
    /// every other test in this file and fail this one.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND NOT REFUSING IS NOT THE SAME AS CONFIRMING.
    /// </summary>
    /// <remarks>
    /// The second lesson, stated as the one outcome a two-valued answer could
    /// not express. A page that sat on an address the whole window and then
    /// failed its own confirmation has told us nothing either way - the
    /// provider neither refused us nor welcomed us - so this is
    /// <c>CannotTell</c>, and only an actual refusal is <c>SignedOut</c>.
    /// <para>
    /// Both drive the ordinary sign-in, so no run behaves differently for the
    /// distinction. What it buys is that "the provider said no" stops being
    /// claimed about a provider that said nothing - which on a catalogue of
    /// providers is the difference between a diagnosis and a guess.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// A browser that was ALREADY on the sign-in page when the check started
    /// pays no window at all.
    /// </summary>
    /// <remarks>
    /// The address is read before the first delay as well as after every one.
    /// Without that, the commonest signed-out case - a provider that redirected
    /// during the navigation itself, so the address had already changed by the
    /// time it returned - would wait out the entire window to learn what it
    /// knew before it started.
    /// </remarks>
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

        // NOT ONE WAIT. Reading the address once is not the same as reading it
        // FIRST: a check that ran its twenty delays and then looked would make
        // the same single read, return the same answer, and cost ten seconds
        // on the commonest signed-out case there is.
        Assert.Equal(0, clock.Waits);
    }

    // ---- fixtures ----------------------------------------------------------

    /// <summary>An adapter that implements none of the optional capability.</summary>
    private sealed class SilentAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => Make.Manifest();

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new InvalidOperationException("this test must not drive a sign-in");

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new InvalidOperationException("this test must not drive a fetch");
    }

    /// <summary>One that would say yes, and counts how often it was asked.</summary>
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

    /// <summary>
    /// The only two things the gate reads off a context, and nothing else: a
    /// double that answered more would let a test assert through a surface the
    /// probe is not allowed to use.
    /// </summary>
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

    /// <summary>
    /// A page that is only an address, and counts how often it was read.
    /// </summary>
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

        /// <summary>
        /// A browser that moves on its own, part way through the watch.
        /// </summary>
        /// <remarks>
        /// The shape the window exists for. A provider that answers its
        /// protected address and bounces a moment later - ASN's overview did
        /// exactly this on 2026-09-19 - looks identical on the first read to
        /// one that never bounces, and a fixture whose address cannot change
        /// cannot tell the two apart.
        /// </remarks>
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

    /// <summary>
    /// A clock that does not move and timers that do not wait, so a counted
    /// poll runs at its real settings without a test taking ten seconds.
    /// </summary>
    /// <remarks>
    /// Only safe because the loop under test is bounded by a COUNT rather than
    /// by the clock. Firing the timers of a loop whose deadline is computed
    /// from a frozen <c>GetUtcNow</c> would spin for ever.
    /// <para>
    /// The callback is queued rather than invoked inside <c>CreateTimer</c>:
    /// <c>Task.Delay</c> creates its timer and then finishes wiring itself up,
    /// and completing it from inside its own constructor is re-entrancy nobody
    /// promised.
    /// </para>
    /// </remarks>
    private sealed class InstantTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private int _waits;

        /// <summary>
        /// How many times the caller asked to wait.
        /// </summary>
        /// <remarks>
        /// The only way this suite can say a window was SPENT rather than
        /// merely counted. A check that ran the whole loop and then read the
        /// address once would satisfy every assertion about the answer and
        /// none about the cost - and the cost is the entire reason the gate
        /// in front of this exists.
        /// </remarks>
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
