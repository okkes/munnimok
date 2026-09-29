using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// What the runner makes of each kind of leased job — a login's material, a
/// fetch's records, a logout that always disconnects locally — the verdicts
/// for the jobs it cannot run at all, and what it does when the control
/// plane will not take the outcome.
/// </summary>
public sealed class JobKindsTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(60);

    private static ProviderManifest Persistent() => TestRig.Manifest with
    {
        Runtime = ProviderRuntime.BrowserPersistent,
    };

    private static LeasedJob Job(JobKind kind, ResourceRequest? request = null, string? profileId = null, int budgetSeconds = 60) =>
        TestRig.Login(budgetSeconds) with { Kind = kind, Request = request, ProfileId = profileId };

    private static IReadOnlyList<ProfileHealth> Profiles(TestRig rig) =>
        rig.Profiles.Snapshot();

    [Fact]
    public async Task A_job_for_a_provider_this_agent_does_not_carry_is_refused_as_unsupported()
    {
        using var rig = new TestRig(new DecidedAdapter());

        await rig.RunAsync(Job(JobKind.Login) with { Provider = "someone-else" }).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(ErrorCode.UnsupportedResource), rig.Control.FailureCode);
        Assert.Null(rig.Control.Result);
    }

    [Fact]
    public async Task A_fetch_returns_what_the_adapter_found_and_the_material_it_refreshed_on_the_way()
    {
        var adapter = new DecidedAdapter
        {
            Fetch = FetchResult.Empty with
            {
                Via = "api",
                Complete = false,
                RefreshedMaterial = DecidedAdapter.Material with { AccessToken = "at_2" },
            },
        };
        using var rig = new TestRig(adapter);
        var request = new ResourceRequest { ResourceId = "transactions", Since = new DateOnly(2026, 9, 1) };

        await rig.RunAsync(Job(JobKind.Fetch, request)).WaitAsync(Patience);

        Assert.Equal(request.ResourceId, adapter.Requested?.ResourceId);
        Assert.Equal(request.Since, adapter.Requested?.Since);
        var result = rig.Control.Result;
        Assert.NotNull(result);
        Assert.Equal("api", result.Via);
        Assert.False(result.Complete);
        Assert.Equal("at_2", result.SessionMaterial?.AccessToken);
        Assert.Null(rig.Control.Failure);
    }

    [Fact]
    public async Task A_fetch_that_arrives_without_a_request_is_an_invalid_request_not_a_crash()
    {
        using var rig = new TestRig(new DecidedAdapter());

        await rig.RunAsync(Job(JobKind.Fetch)).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(ErrorCode.InvalidRequest), rig.Control.FailureCode);
        Assert.Contains("no resource request", rig.Control.Failure?.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_logout_disconnects_locally_even_when_the_provider_side_sign_out_breaks()
    {
        var adapter = new DecidedAdapter { LogoutThrows = true };
        using var rig = new TestRig(adapter);

        await rig.RunAsync(Job(JobKind.Logout)).WaitAsync(Patience);

        Assert.True(adapter.LoggedOut);
        Assert.Null(rig.Control.Failure);
        Assert.True(rig.Control.Result?.Complete);
    }

    [Fact]
    public async Task A_login_on_a_persistent_provider_mints_a_profile_and_stamps_the_material_with_it()
    {
        using var rig = new TestRig(new DecidedAdapter(), manifest: Persistent());

        await rig.RunAsync(Job(JobKind.Login)).WaitAsync(Patience);

        var material = rig.Control.Result?.SessionMaterial;
        Assert.NotNull(material);
        Assert.Equal("agt_test", material.AgentId);
        Assert.False(string.IsNullOrEmpty(material.ProfileId));
        var profile = Assert.Single(Profiles(rig));
        Assert.Equal(material.ProfileId, profile.Id);
        Assert.True(profile.Healthy);
        Assert.NotNull(profile.LastOk);
    }

    [Fact]
    public async Task A_fetch_on_a_persistent_provider_needs_the_profile_its_login_minted()
    {
        using var rig = new TestRig(new DecidedAdapter(), manifest: Persistent());

        await rig.RunAsync(Job(JobKind.Fetch, new ResourceRequest { ResourceId = "transactions" })).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(ErrorCode.InvalidRequest), rig.Control.FailureCode);
        Assert.Contains("carries no profile id", rig.Control.Failure?.Detail, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(ErrorCode.SessionExpired)]
    [InlineData(ErrorCode.InvalidCredentials)]
    [InlineData(ErrorCode.MfaFailed)]
    public async Task A_refusal_that_means_the_profile_stopped_authenticating_marks_it_unhealthy(ErrorCode code)
    {
        using var rig = new TestRig(new DecidedAdapter { Refuses = code }, manifest: Persistent());

        await rig.RunAsync(Job(JobKind.Login, profileId: "prf_kept")).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(code), rig.Control.FailureCode);
        var profile = Assert.Single(Profiles(rig));
        Assert.Equal("prf_kept", profile.Id);
        Assert.False(profile.Healthy);
    }

    [Fact]
    public async Task A_refusal_that_says_nothing_about_the_profile_leaves_it_healthy()
    {
        using var rig = new TestRig(new DecidedAdapter { Refuses = ErrorCode.ProviderUnavailable }, manifest: Persistent());

        await rig.RunAsync(Job(JobKind.Login, profileId: "prf_kept")).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(ErrorCode.ProviderUnavailable), rig.Control.FailureCode);
        Assert.True(Assert.Single(Profiles(rig)).Healthy);
    }

    [Fact]
    public async Task A_result_the_control_plane_refuses_outright_is_posted_once_and_left_to_the_lease()
    {
        using var rig = new TestRig(new DecidedAdapter(), manifest: Persistent());
        rig.Control.ResultStatus = HttpStatusCode.BadRequest;

        await rig.RunAsync(Job(JobKind.Login)).WaitAsync(Patience);

        Assert.Equal(1, rig.Control.ResultCount);
        Assert.Null(rig.Control.Failure);
        Assert.Null(Assert.Single(Profiles(rig)).LastOk);
    }

    [Fact]
    public async Task A_failure_report_the_control_plane_cannot_take_is_retried_and_then_given_up()
    {
        using var rig = new TestRig(new DecidedAdapter { Refuses = ErrorCode.ProviderUnavailable });
        rig.Control.FailStatus = HttpStatusCode.InternalServerError;

        await rig.RunAsync(Job(JobKind.Login)).WaitAsync(Patience);

        Assert.Equal(3, rig.Control.FailureCount);
        Assert.Null(rig.Control.Result);
    }

    [Fact]
    public async Task A_lease_the_control_plane_no_longer_holds_stops_the_run_without_a_terminal_post()
    {
        var clock = new TestClock();
        var adapter = new DecidedAdapter { Parks = true };
        using var rig = new TestRig(adapter, time: clock);
        rig.Control.RenewRefused = true;

        var run = rig.RunAsync(Job(JobKind.Login, budgetSeconds: 600), leaseTtlSeconds: 120);
        await adapter.Parked.Task.WaitAsync(Patience);
        clock.Advance(TimeSpan.FromSeconds(61));
        await run.WaitAsync(Patience);

        Assert.Equal(1, rig.Control.Renewals);
        Assert.Null(rig.Control.Result);
        Assert.Null(rig.Control.Failure);
    }
}
