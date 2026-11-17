using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests;

public sealed class RequestAndStatusTests
{
    private static readonly string[] SelectedAccounts = ["savings", "credit_card"];

    private static readonly string[] ItemsOnly = ["items"];

    [Fact]
    public void An_absent_selection_reads_as_empty_and_never_as_null()
    {
        var request = new ResourceRequest { ResourceId = "transactions" };

        // an adapter null-checking every selection forgets one, and that fetch returns everything instead of what was asked
        Assert.Empty(request.Include);
        Assert.Empty(request.Accounts);
        Assert.False(request.WantsItems);
    }

    [Fact]
    public void Selections_are_surfaced_by_name()
    {
        var request = new ResourceRequest
        {
            ResourceId = "transactions",
            Since = new DateOnly(2026, 1, 1),
            Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                ["accounts"] = ["savings", "credit_card"],
                ["include"] = ["items"],
            },
        };

        Assert.Equal(SelectedAccounts, request.Accounts);
        Assert.Equal(ItemsOnly, request.Include);
        Assert.True(request.WantsItems);
        Assert.Equal(new DateOnly(2026, 1, 1), request.Since);
        Assert.Null(request.Until);
    }

    [Fact]
    public void Include_matching_is_ordinal()
    {
        var request = new ResourceRequest
        {
            ResourceId = "receipts",
            Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                ["include"] = ["Items"],
            },
        };

        // the manifest declares lower-case values; accepting a near-miss would make its enum advisory
        Assert.False(request.WantsItems);
    }

    [Fact]
    public void A_challenge_expires_at_its_stated_instant()
    {
        var challenge = new Challenge { Type = ChallengeType.Image, ExpiresAt = TestTime.Anchor };

        // a challenge holds a live browser: a stale one must fail the job cleanly, not pin an agent for the full timeout
        Assert.False(challenge.IsExpired(TestTime.Anchor.AddTicks(-1)));
        Assert.True(challenge.IsExpired(TestTime.Anchor));
        Assert.True(challenge.IsExpired(TestTime.Anchor.AddMinutes(1)));
    }

    [Theory]
    [InlineData(ChallengeType.AppApproval, true)]
    [InlineData(ChallengeType.Image, false)]
    [InlineData(ChallengeType.MfaCode, false)]
    [InlineData(ChallengeType.CodeDisplay, false)]
    [InlineData(ChallengeType.QrDisplay, false)]
    [InlineData(ChallengeType.SelectOption, false)]
    [InlineData(ChallengeType.Redirect, false)]
    public void Only_app_approval_expects_no_typed_answer(ChallengeType type, bool passive)
    {
        var challenge = new Challenge { Type = type, ExpiresAt = TestTime.Anchor.AddMinutes(3) };

        Assert.Equal(passive, challenge.IsPassive);
    }

    [Fact]
    public void A_challenge_never_serialises_its_image_or_crop()
    {
        // image bytes are ephemeral and travel by a separate authenticated fetch, never in a status payload
        var image = typeof(Challenge).GetProperty(nameof(Challenge.Image))!;
        var crop = typeof(Challenge).GetProperty(nameof(Challenge.Crop))!;

        Assert.NotEmpty(image.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonIgnoreAttribute), false));
        Assert.NotEmpty(crop.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonIgnoreAttribute), false));
    }

    [Theory]
    [InlineData(ProviderState.Healthy, true)]
    [InlineData(ProviderState.Degraded, true)]
    [InlineData(ProviderState.Paused, false)]
    [InlineData(ProviderState.Retired, false)]
    public void The_kill_switch_stops_new_work_without_stopping_a_degraded_provider(
        ProviderState state, bool acceptsWork)
    {
        var status = new ProviderStatus { ProviderId = "jumbo", State = state, Since = TestTime.Anchor };

        // Degraded: something is wrong and an operator knows, work still flows; Paused is the switch that stops it
        Assert.Equal(acceptsWork, status.AcceptsWork);
    }

    [Fact]
    public void A_healthy_status_is_healthy_and_dated()
    {
        var status = ProviderStatus.Healthy("jumbo", TestTime.Anchor);

        Assert.Equal(ProviderState.Healthy, status.State);
        Assert.Equal(TestTime.Anchor, status.Since);
        Assert.True(status.AcceptsWork);
        Assert.Null(status.ReasonKey);
    }

    [Fact]
    public void An_agent_serves_only_what_it_advertises()
    {
        var manifest = Make.Manifest() with { Id = "jumbo", Runtime = ProviderRuntime.Http };

        var anything = new Connector.Kit.AgentProtocol.AgentCapabilities();
        var wrongProvider = new Connector.Kit.AgentProtocol.AgentCapabilities { Providers = ["asn"] };
        var wrongRuntime = new Connector.Kit.AgentProtocol.AgentCapabilities
        {
            Runtimes = [ProviderRuntime.BrowserPersistent],
        };
        var match = new Connector.Kit.AgentProtocol.AgentCapabilities
        {
            Providers = ["jumbo"],
            Runtimes = [ProviderRuntime.Http],
        };

        // empty means "any" on both axes, so a pooled agent can opt into everything without listing it
        Assert.True(anything.CanServe(manifest));
        Assert.False(wrongProvider.CanServe(manifest));
        Assert.False(wrongRuntime.CanServe(manifest));
        Assert.True(match.CanServe(manifest));
    }
}
