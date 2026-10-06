using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Exploring;
using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests.Exploring;

/// <summary>
/// The operator's explore provider (#441 L3): a valid manifest with nothing
/// to fetch, operator-only, and an address rule that keeps the fleet's
/// browser off the household's own network.
/// </summary>
public sealed class ExploreProviderTests
{
    [Fact]
    public void The_manifest_validates_is_operator_only_and_fetches_nothing()
    {
        ManifestValidator.Validate(ExploreProvider.Manifest);

        Assert.True(ExploreProvider.Manifest.OperatorOnly);
        Assert.Empty(ExploreProvider.Manifest.Resources);
        Assert.Equal(ProviderKind.Lab, ExploreProvider.Manifest.Kind);
        Assert.True(ExploreProvider.Manifest.Agent.Required);
        Assert.Equal(ExploreProvider.UrlField, Assert.Single(ExploreProvider.Manifest.Auth.AllFields()).Key);
    }

    [Fact]
    public void A_party_a_person_connects_to_still_needs_a_resource()
    {
        var bare = ExploreProvider.Manifest with { Id = "bare", OperatorOnly = false };

        var refused = Assert.Throws<InvalidOperationException>(() => ManifestValidator.Validate(bare));
        Assert.Contains("at least one resource", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://www.example.com/")]
    [InlineData("http://shop.example.nl/orders?page=2")]
    [InlineData("https://8.8.8.8/")]
    [InlineData("  https://www.example.com/trimmed  ")]
    public void A_public_http_address_is_navigable(string raw)
    {
        Assert.True(ExploreProvider.IsNavigable(raw, out var uri));
        Assert.StartsWith("http", uri.Scheme, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ftp://www.example.com/")]
    [InlineData("javascript:alert(1)")]
    [InlineData("file:///etc/passwd")]
    [InlineData("https://user:pw@www.example.com/")]
    [InlineData("http://localhost/")]
    [InlineData("http://nas/")]
    [InlineData("http://127.0.0.1:5001/")]
    [InlineData("http://10.0.0.1/")]
    [InlineData("http://172.16.0.1/")]
    [InlineData("http://192.168.1.1/")]
    [InlineData("http://169.254.1.1/")]
    [InlineData("http://100.64.0.1/")]
    [InlineData("http://[::1]/")]
    [InlineData("http://[fe80::1]/")]
    [InlineData("http://[fd00::1]/")]
    [InlineData("http://nas.local/")]
    [InlineData("http://router.lan/")]
    [InlineData("http://app.internal/")]
    [InlineData("http://home.home.arpa/")]
    public void A_private_or_odd_address_is_not(string? raw)
    {
        Assert.False(ExploreProvider.IsNavigable(raw, out _));
    }

    [Fact]
    public void An_address_past_the_cap_is_refused()
    {
        Assert.False(ExploreProvider.IsNavigable("https://www.example.com/" + new string('a', ExploreProvider.MaxUrlLength), out _));
    }

    [Fact]
    public async Task The_control_planes_copy_describes_the_manifest_and_runs_nothing()
    {
        Assert.Same(ExploreProvider.Manifest, ExploreProvider.ManifestOnly.Describe());

        var refused = await Assert.ThrowsAsync<ConnectorException>(() =>
            ExploreProvider.ManifestOnly.LoginAsync(null!, CancellationToken.None));
        Assert.Equal(ErrorCode.UnsupportedResource, refused.Code);

        var registry = new ProviderRegistry([ExploreProvider.ManifestOnly]);
        Assert.True(registry.TryGetManifest(ExploreProvider.Id, out _));
    }
}
