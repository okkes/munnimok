using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Kit.Agent.Tests;

// an internal fault costs the session (the control plane discards it) but the connector signs out upstream first, so the
// provider is not left holding it; only where a human signs in for every fetch, never a long-lived connection
public class SignOutOnFailureTests
{
    private static ProviderManifest SignsOut() => TestRig.Manifest with
    {
        Logout = LogoutSupport.Session,
    };

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

    // the courtesy is for a pooled agent's session left alive in a datacenter; on BYO the signed-in browser is the asset
    [Fact]
    public async Task A_session_on_your_own_agent_is_never_signed_out_by_us()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: SignsOut());
        rig.Options.Class = AgentClass.Byo;

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);

        Assert.False(
            ((SigningAdapter)rig.Adapter).SignedOut,
            "our bug cost the account holder the sign-in they keep this machine to avoid");
    }

    // a leased job must always reach a terminal state; failure artifacts must show what broke, not the signed-out page
    [Fact]
    public async Task The_sign_out_happens_after_the_failure_is_reported()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: SignsOut());
        var adapter = (SigningAdapter)rig.Adapter;

        // asked of the control plane at the moment the sign-out runs: a flag defaulting to "yes" is not an observation
        adapter.FailurePosted = () => rig.Control.Failure is not null;

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.True(adapter.SignedOut, "the sign-out never ran, so the ordering was never tested");
        Assert.True(
            adapter.FailureWasPostedFirst,
            "the session was signed out before the job had been reported failed - a courtesy that hangs "
            + "would then take the terminal post with it, and the failure artifacts would photograph the "
            + "signed-out page instead of whatever broke");
    }

    // `internal` is retriable: signing out on attempt one hands attempt two a dead cookie jar; the control plane owns retries
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

    // a sign-in that did not hold leaves nothing to end, and another browser visit to a bank is an unexplained hit
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

    // owner's rule: sign out where a human must sign in for every fetch; a refreshable session needs nobody for the next one
    [Fact]
    public async Task A_refreshable_session_is_left_alone()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: Renews());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.NotNull(rig.Control.Failure);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    [Fact]
    public async Task A_provider_that_declares_no_logout_is_not_asked_for_one()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(), manifest: TestRig.Manifest);

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.NotNull(rig.Control.Failure);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    // a standalone logout job once tested !Browser.Started and silently did nothing (its browser had not started yet);
    // here no browser means no session, and launching Chromium to visit a bank because of a failure is worse than nothing
    [Fact]
    public async Task A_run_that_never_opened_a_browser_signs_nothing_out()
    {
        using var rig = new TestRig(SigningAdapter.ThrowsWithoutOpening(), manifest: SignsOut());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);
        Assert.False(((SigningAdapter)rig.Adapter).SignedOut);
    }

    // the job is already terminal: an escaping exception would post a second terminal result, no-opped by the queue,
    // burning three retries at thirty seconds each
    [Fact]
    public async Task A_sign_out_that_throws_is_swallowed()
    {
        using var rig = new TestRig(SigningAdapter.OpensThenThrows(signOutThrows: true), manifest: SignsOut());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(TimeSpan.FromSeconds(60));

        Assert.True(((SigningAdapter)rig.Adapter).SignedOut, "the sign-out was never attempted");
        Assert.Equal(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);

        Assert.Equal(1, rig.Control.FailureCount);
    }
}

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

    public static SigningAdapter OpensThenThrows(bool signOutThrows = false) =>
        new(opens: true, refuses: null, signOutThrows);

    public static SigningAdapter OpensThenRefuses(ErrorCode code) =>
        new(opens: true, refuses: code, signOutThrows: false);

    public static SigningAdapter ThrowsWithoutOpening() =>
        new(opens: false, refuses: null, signOutThrows: false);

    public bool SignedOut { get; private set; }

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
