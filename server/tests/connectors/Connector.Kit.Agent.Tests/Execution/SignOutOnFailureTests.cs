using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// What happens to somebody's provider session when a fetch dies of OUR bug.
///
/// <para>
/// The decision it implements: an internal fault costs the session - the
/// control plane discards it and the account holder signs in again - but the
/// connector signs OUT upstream first, so a session it abandoned is not one the
/// provider is left holding open. Only for providers where a human has to sign
/// in for every fetch; a long-lived connection is not revoked over our mistake.
/// </para>
///
/// <para>
/// Every test here is a gate, and every gate is a case that would do harm.
/// </para>
/// </summary>
public class SignOutOnFailureTests
{
    /// <summary>A provider that has a sign-out and cannot renew a session.</summary>
    private static ProviderManifest SignsOut() => TestRig.Manifest with
    {
        Logout = LogoutSupport.Session,
    };

    /// <summary>
    /// The same, but its session renews itself - a shop's thirty-day jar.
    /// </summary>
    private static ProviderManifest Renews() => TestRig.Manifest with
    {
        Logout = LogoutSupport.Session,
        Auth = TestRig.Manifest.Auth with
        {
            Session = TestRig.Manifest.Auth.Session with { Refreshable = true },
        },
    };

    [Fact]
    public async Task A_session_left_behind_by_our_own_bug_is_signed_out()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: SignsOut());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);
        Assert.True(
            ((SigningAdapter)rig.Adapter).SignedOut,
            "the fetch failed on our side and left the provider session open");
    }

    /// <summary>
    /// BUT NEVER ON A MACHINE THE ACCOUNT HOLDER BROUGHT.
    /// </summary>
    /// <remarks>
    /// The courtesy exists because a pooled agent leaves a session alive in a
    /// datacenter nobody will return to. An agent somebody stood up themselves
    /// is the opposite in every respect: the signed-in browser is the ASSET -
    /// the entire reason the container exists - and signing it out to tidy up
    /// after OUR bug costs them the scan, the phone and the login they did once
    /// so they would not have to do it again.
    /// <para>
    /// Same adapter, same failure, same manifest as the test above. The only
    /// difference is whose machine it is.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_session_on_your_own_agent_is_never_signed_out_by_us()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: SignsOut());
        rig.Options.Class = AgentClass.Byo;

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        // It failed exactly as it does on a pooled agent...
        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);

        // ...and the session it left behind is still there, which is the point.
        Assert.False(
            ((SigningAdapter)rig.Adapter).SignedOut,
            "our bug cost the account holder the sign-in they keep this machine to avoid");
    }

    /// <summary>
    /// AND ONLY AFTER THE FAILURE HAS BEEN REPORTED.
    /// </summary>
    /// <remarks>
    /// The invariant this runner exists to hold is that a leased job always
    /// reaches a terminal state. A courtesy performed before the post could
    /// hang and take that with it - and the artifacts captured for the failure
    /// would become a photograph of the signed-out page rather than of whatever
    /// broke.
    /// </remarks>
    [Fact]
    public async Task The_sign_out_happens_after_the_failure_is_reported()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: SignsOut());
        var adapter = (SigningAdapter)rig.Adapter;

        // Asked of the control plane at the moment the sign-out runs, rather
        // than assumed. A flag that defaults to "yes" is not an observation.
        adapter.FailurePosted = () => rig.Control.Failure is not null;

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.True(adapter.SignedOut, "the sign-out never ran, so the ordering was never tested");
        Assert.True(
            adapter.FailureWasPostedFirst,
            "the session was signed out before the job had been reported failed - a courtesy that hangs "
            + "would then take the terminal post with it, and the failure artifacts would photograph the "
            + "signed-out page instead of whatever broke");
    }

    /// <summary>
    /// A JOB THE QUEUE PUT BACK IS NOT OVER, so its session is left alone.
    /// </summary>
    /// <remarks>
    /// <c>internal</c> is retriable. An agent that signed out on attempt one
    /// would hand attempt two a dead cookie jar, and one bug of ours would
    /// become an expired session - the account holder signing in again for a
    /// reason we invented. The control plane owns the retry policy, so it
    /// decides and says so on the wire; this is the agent believing it.
    /// </remarks>
    [Fact]
    public async Task A_failure_the_control_plane_requeued_leaves_the_session_alive()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: SignsOut());
        rig.Control.FailState = JobState.Queued;

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.NotNull(rig.Control.Failure);
        Assert.False(
            ((SigningAdapter)rig.Adapter).SignedOut,
            "the job was put back on the queue and the next attempt was handed a session that had been ended");
    }

    /// <summary>
    /// A SESSION THAT IS ALREADY GONE IS NOT VISITED AGAIN.
    /// </summary>
    /// <remarks>
    /// <c>session_expired</c>, <c>invalid_credentials</c> and <c>mfa_failed</c>
    /// all mean the sign-in did not hold. Driving a bank's browser around a
    /// login it never got past is a second unexplained visit to an account
    /// whose fraud rules are already watching, and it can end nothing, because
    /// there is nothing to end.
    /// </remarks>
    [Theory]
    [InlineData(ErrorCode.SessionExpired)]
    [InlineData(ErrorCode.InvalidCredentials)]
    [InlineData(ErrorCode.MfaFailed)]
    public async Task A_failure_that_means_the_session_never_held_signs_nothing_out(ErrorCode code)
    {
        using var rig = new TestRig(SigningAdapter.OpensThenRefuses(code), manifest: SignsOut());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal(ErrorCatalog.Wire(code), rig.Control.FailureCode);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    /// <summary>
    /// A CONNECTION THAT RENEWS ITSELF IS NOT REVOKED OVER OUR MISTAKE.
    /// </summary>
    /// <remarks>
    /// This is the half of the rule the account holder asked for: sign out
    /// where a human must sign in for every fetch, and leave the long-lived
    /// ones alone. A refreshable session is one where the next fetch needs
    /// nobody - ending it turns our bug into their chore.
    /// </remarks>
    [Fact]
    public async Task A_refreshable_session_is_left_alone()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: Renews());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.NotNull(rig.Control.Failure);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    /// <summary>A provider with no sign-out is not asked to perform one.</summary>
    [Fact]
    public async Task A_provider_that_declares_no_logout_is_not_asked_for_one()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: TestRig.Manifest);

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.NotNull(rig.Control.Failure);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    /// <summary>
    /// NO BROWSER MEANS NO SESSION, and the check is the inverse of a famous bug.
    /// </summary>
    /// <remarks>
    /// A standalone logout job once tested <c>!Browser.Started</c> and silently
    /// did nothing every time, because a logout job's browser has been nowhere
    /// yet. Here the browser IS the session: a run that never opened one has
    /// nothing to sign out of, and launching Chromium to visit a bank on the
    /// strength of a failure is worse than doing nothing.
    /// </remarks>
    [Fact]
    public async Task A_run_that_never_opened_a_browser_signs_nothing_out()
    {
        using var rig = new TestRig(SigningAdapter.ThrowsWithoutOpening(), manifest: SignsOut());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    /// <summary>
    /// A SIGN-OUT THAT THROWS DOES NOT BECOME A SECOND FAILURE.
    /// </summary>
    /// <remarks>
    /// The job has already been reported terminal. An exception escaping the
    /// courtesy would reach the runner's outer catch and post a second terminal
    /// result for a job the queue has closed - silently, because the queue
    /// no-ops on a terminal job, while burning three retries at thirty seconds
    /// each.
    /// </remarks>
    [Fact]
    public async Task A_sign_out_that_throws_is_swallowed()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(signOutThrows: true), manifest: SignsOut());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.True(((SigningAdapter)rig.Adapter).SignedOut, "the sign-out was never attempted");
        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);

        // One terminal post, not two.
        Assert.Equal(1, rig.Control.FailureCount);
    }
}

/// <summary>
/// An adapter that can open a browser, fail on cue, and remember whether it was
/// ever asked to sign out.
/// </summary>
internal sealed class SigningAdapter : IProviderAdapter
{
    private readonly bool _opens;
    private readonly bool _signOutThrows;
    private readonly ErrorCode? _refuses;

    private SigningAdapter(bool opens, ErrorCode? refuses, bool signOutThrows)
    {
        _opens = opens;
        _refuses = refuses;
        _signOutThrows = signOutThrows;
    }

    /// <summary>Opens a page, then throws something that is ours by definition.</summary>
    public static SigningAdapter OpensThenThrows(bool signOutThrows = false) =>
        new(opens: true, refuses: null, signOutThrows);

    /// <summary>Opens a page, then refuses with a code the caller chooses.</summary>
    public static SigningAdapter OpensThenRefuses(ErrorCode code) =>
        new(opens: true, refuses: code, signOutThrows: false);

    /// <summary>Fails before it ever touches a browser.</summary>
    public static SigningAdapter ThrowsWithoutOpening() =>
        new(opens: false, refuses: null, signOutThrows: false);

    public bool SignedOut { get; private set; }

    /// <summary>
    /// Whether the failure had already been posted when the sign-out ran.
    /// </summary>
    public bool FailureWasPostedFirst { get; private set; }

    public Func<bool>? FailurePosted { get; set; }

    public ProviderManifest Describe() => TestRig.Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        if (_opens) await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        if (_refuses is { } code) throw new ConnectorException(code, "scripted refusal");

        throw new InvalidOperationException("scripted fault");
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        Task.FromResult(FetchResult.Empty);

    public Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        SignedOut = true;
        FailureWasPostedFirst = FailurePosted?.Invoke() ?? false;

        ctx.Note("signed out upstream");

        return _signOutThrows
            ? throw new InvalidOperationException("the sign-out itself broke")
            : Task.CompletedTask;
    }
}
