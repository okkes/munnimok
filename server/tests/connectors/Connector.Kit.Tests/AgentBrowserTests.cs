using System.Text.Json;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Xunit;

namespace Connector.Kit.Tests;

/// <summary>
/// #562: an agent says which browser it runs, so that one left behind on
/// somebody's own computer can be told to renew - the pooled ones follow
/// every deploy by themselves.
/// </summary>
public sealed class AgentBrowserTests
{
    [Fact]
    public void This_build_names_the_browser_it_drives_as_a_plain_version()
    {
        Assert.True(Version.TryParse(AgentBrowser.Version, out var version));
        // the release, not the "1.0.0" Playwright stamps on every build of its assembly
        Assert.True(version >= new Version(1, 64), AgentBrowser.Version);
        Assert.DoesNotContain('+', AgentBrowser.Version);
        Assert.DoesNotContain('-', AgentBrowser.Version);
    }

    [Theory]
    [InlineData("1.63.0", "1.64.1", true)]
    [InlineData("1.64.0", "1.64.1", true)]
    [InlineData("1.64.1", "1.64.1", false)]
    // an agent a deploy renewed a moment before the control plane is ahead, not behind
    [InlineData("1.65.0", "1.64.1", false)]
    // the claim is newer than an agent that does not make it
    [InlineData(null, "1.64.1", true)]
    [InlineData("", "1.64.1", true)]
    // what nobody can read judges nothing
    [InlineData("chromium", "1.64.1", false)]
    [InlineData("1.63.0", "unknown", false)]
    public void An_agent_is_behind_when_it_names_an_older_browser_or_none(string? reported, string ours, bool behind)
    {
        Assert.Equal(behind, AgentBrowser.IsBehind(reported, ours));
    }

    [Fact]
    public void The_claim_travels_with_the_capabilities_under_its_wire_name()
    {
        var json = JsonSerializer.Serialize(new AgentCapabilities { BrowserVersion = "1.64.1" }, ConnectorWireJson.Options);
        Assert.Contains("\"browser_version\":\"1.64.1\"", json, StringComparison.Ordinal);
        Assert.Equal("1.64.1", JsonSerializer.Deserialize<AgentCapabilities>(json, ConnectorWireJson.Options)!.BrowserVersion);
        // an agent built before the claim existed sends none
        Assert.Null(JsonSerializer.Deserialize<AgentCapabilities>("{}", ConnectorWireJson.Options)!.BrowserVersion);
    }
}
