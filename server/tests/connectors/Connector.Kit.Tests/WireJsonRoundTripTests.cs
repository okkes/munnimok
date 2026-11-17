using System.Text.Json;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Xunit;

namespace Connector.Kit.Tests;

// control plane and agent must encode the protocol identically: ResourceRequest lacked [JsonPropertyName], so every
// agent-served fetch failed to deserialize and sat queued, while logins (Request null) kept working
public sealed class WireJsonRoundTripTests
{
    [Fact]
    public void ResourceRequest_round_trips_through_the_canonical_encoding()
    {
        var request = new ResourceRequest
        {
            ResourceId = "receipts",
            Since = new DateOnly(2026, 1, 1),
            Until = new DateOnly(2026, 7, 1),
            Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                ["include"] = ["items"],
                ["accounts"] = ["savings", "credit_card"],
            },
        };

        var json = JsonSerializer.Serialize(request, ConnectorWireJson.Options);
        var back = JsonSerializer.Deserialize<ResourceRequest>(json, ConnectorWireJson.Options);

        Assert.NotNull(back);
        Assert.Equal("receipts", back.ResourceId);
        Assert.Equal(request.Since, back.Since);
        Assert.Equal(["items"], back.Include);
        Assert.Equal(["savings", "credit_card"], back.Accounts);
    }

    [Fact]
    public void The_wire_uses_snake_case_for_properties_without_an_explicit_name()
    {
        var json = JsonSerializer.Serialize(
            new ResourceRequest { ResourceId = "receipts" }, ConnectorWireJson.Options);

        Assert.Contains("\"resource_id\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"resourceId\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void A_leased_fetch_job_round_trips()
    {
        var job = new LeasedJob
        {
            JobId = Ids.New(Ids.Job),
            SessionId = Ids.New(Ids.Session),
            Provider = "ah",
            Kind = JobKind.Fetch,
            Material = new SessionMaterial { RefreshToken = "rt", DeviceId = "dev" },
            Config = new Dictionary<string, string>(StringComparer.Ordinal) { ["country"] = "NL" },
            Request = new ResourceRequest
            {
                ResourceId = "receipts",
                Since = new DateOnly(2026, 1, 1),
                Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                {
                    ["include"] = ["items"],
                },
            },
            LeaseExpiresAt = DateTimeOffset.UtcNow.AddMinutes(2),
        };

        var json = JsonSerializer.Serialize(job, ConnectorWireJson.Options);
        var back = JsonSerializer.Deserialize<LeasedJob>(json, ConnectorWireJson.Options);

        Assert.NotNull(back);
        Assert.Equal(JobKind.Fetch, back.Kind);
        Assert.NotNull(back.Request);
        Assert.Equal("receipts", back.Request.ResourceId);
        Assert.True(back.Request.WantsItems);
        Assert.Equal("rt", back.Material?.RefreshToken);
        Assert.Equal("NL", back.Config["country"]);
    }

    [Fact]
    public void A_leased_login_job_carries_no_request()
    {
        var job = new LeasedJob
        {
            JobId = Ids.New(Ids.Job),
            SessionId = Ids.New(Ids.Session),
            Provider = "ah",
            Kind = JobKind.Login,
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal) { ["username"] = "u" },
            LeaseExpiresAt = DateTimeOffset.UtcNow.AddMinutes(2),
        };

        var back = JsonSerializer.Deserialize<LeasedJob>(
            JsonSerializer.Serialize(job, ConnectorWireJson.Options), ConnectorWireJson.Options);

        Assert.NotNull(back);
        Assert.Null(back.Request);
        Assert.Equal("u", back.Inputs["username"]);
    }

    [Theory]
    [InlineData(JobState.AwaitingInput, "awaiting_input")]
    [InlineData(JobState.Succeeded, "succeeded")]
    public void Enums_are_snake_case(JobState state, string expected)
    {
        Assert.Equal($"\"{expected}\"", JsonSerializer.Serialize(state, ConnectorWireJson.Options));
    }

    [Fact]
    public void Provider_runtime_survives_the_round_trip()
    {
        var json = JsonSerializer.Serialize(ProviderRuntime.BrowserOnce, ConnectorWireJson.Options);
        Assert.Equal("\"browser_once\"", json);
        Assert.Equal(ProviderRuntime.BrowserOnce,
            JsonSerializer.Deserialize<ProviderRuntime>(json, ConnectorWireJson.Options));
    }

    // dictionary keys are data (adapter inputs, provider config, provider ids): renaming them would corrupt a payload
    [Fact]
    public void Dictionary_keys_are_left_exactly_as_written()
    {
        var json = JsonSerializer.Serialize(
            new Dictionary<string, string>(StringComparer.Ordinal) { ["redirect_url"] = "x", ["userName"] = "y" },
            ConnectorWireJson.Options);

        Assert.Contains("\"redirect_url\"", json, StringComparison.Ordinal);
        Assert.Contains("\"userName\"", json, StringComparison.Ordinal);
    }
}
