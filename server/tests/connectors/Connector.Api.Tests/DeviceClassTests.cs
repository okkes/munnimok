using Connector.Kit.Adapters;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Security;
using Connector.Kit.Sessions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// api-spec §1.5, §8.1: a web bundle lives in sessionStorage and dies with the tab, so a web client gets the manifest's own
/// lifetime (a deployment may configure a shorter one); asserted on the bundle's contents, not a response field
[Collection(ShopApiCollection.Name)]
public sealed class DeviceClassTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Simple;

    /// <summary>The manifest's own TTL: 30 days.</summary>
    private const int ManifestTtlSeconds = 2_592_000;

    /// must track ConnectorOptions.WebBundleMaxTtlSeconds; it caps the sealed WRAPPER, never the credential inside

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    /// the exact lifetime, not a range: the number IS the policy, and an InRange(1, 43_200) test passed at anything between
    [Fact]
    public async Task A_web_client_gets_the_manifest_lifetime_because_the_tab_is_the_boundary()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, Provider, Flows.NewSubject("web"), Credentials, deviceClass: "web");

        Assert.Equal(ManifestTtlSeconds, (int)LifetimeOf(connection).TotalSeconds);

        // the load-bearing bound: the bundle is ephemeral, so it dies with the tab whatever its TTL says
        var view = await Flows.ReadSessionAsync(http, Provider, connection.SessionId);
        Assert.Equal("ephemeral", view.Text("custody"));
    }

    /// a deployment can still configure a second deadline inside the tab's; the default changed, not the mechanism
    [Fact]
    public void A_configured_cap_still_shortens_a_web_bundle()
    {
        var options = new ConnectorOptions { Timeouts = { WebBundleMaxTtlSeconds = 3_600 } };
        var manifest = factory.Services.GetRequiredService<IProviderRegistry>().RequireManifest(Provider);

        // TtlSecondsFor reads only the manifest and options, so the other collaborators need no fixture
        var sessions = new SessionService(
            db: null!, registry: null!, codec: null!, tickets: null!, signals: null!,
            options: Options.Create(options), time: TimeProvider.System);

        Assert.Equal(3_600, sessions.TtlSecondsFor(manifest, DeviceClass.Web));
        Assert.Equal(ManifestTtlSeconds, sessions.TtlSecondsFor(manifest, DeviceClass.Native));
    }

    [Fact]
    public async Task A_native_client_gets_the_full_manifest_lifetime()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, Provider, Flows.NewSubject("native"), Credentials, deviceClass: "native");

        // the cap never applies to a non-web provider; if it did, a native user would silently re-authenticate every hour
        Assert.Equal(ManifestTtlSeconds, (int)LifetimeOf(connection).TotalSeconds);

        var view = await Flows.ReadSessionAsync(http, Provider, connection.SessionId);
        Assert.Null(view.TextOrNull("custody"));
    }

    [Fact]
    public async Task An_absent_device_class_header_is_treated_as_native()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("default-device"), Credentials);

        // the historical default and the safe one: web rules only shorten a bundle's life, so guessing web breaks native clients
        Assert.Equal(ManifestTtlSeconds, (int)LifetimeOf(connection).TotalSeconds);
    }

    /// opens the bundle with the service's own key ring: the response's expires_at is a claim, the ciphertext the fact
    private TimeSpan LifetimeOf(Connection connection)
    {
        var codec = factory.Services.GetRequiredService<SealedBundleCodec>();
        var manifest = factory.Services.GetRequiredService<IProviderRegistry>().RequireManifest(Provider);

        var payload = codec.Open(
            connection.Bundle,
            new BundleBinding(Provider, connection.Subject, manifest.ManifestVersion));

        return payload.ExpiresAt - payload.IssuedAt;
    }
}
