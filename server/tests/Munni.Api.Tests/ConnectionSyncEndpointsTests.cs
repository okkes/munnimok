using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Munni.Api.Tests;

/// <summary>
/// E2EE connection sync: the server stores public keys, wraps and
/// credential-bundle ciphertext it cannot open — and never leaks them
/// across users. The crypto itself is client-side and tested in the web suite.
/// </summary>
public class ConnectionSyncEndpointsTests : IClassFixture<AdminApiFactory>
{
    private const string Root = "/me/connection-sync";
    private const string Devices = Root + "/devices";
    private const string Connections = Root + "/connections";

    private readonly AdminApiFactory _factory;

    public ConnectionSyncEndpointsTests(AdminApiFactory factory) => _factory = factory;

    private async Task<HttpClient> ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        await client.GetAsync("/me"); // materialize the user
        return client;
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    [Fact]
    public async Task EnrollmentHandshake_RegisterWrapPoll()
    {
        var client = await ClientFor("sync-alice");
        // two devices register; the first one gets approved out-of-band
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(Devices, new { deviceId = "dev-a", publicJwk = "{jwk-a}", name = "iPhone" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(Devices, new { deviceId = "dev-b", publicJwk = "{jwk-b}", name = "Desktop" })).StatusCode);

        // the new device polls: nothing wrapped for it yet
        Assert.Equal(HttpStatusCode.NoContent, (await client.GetAsync($"{Devices}/dev-b/wrap")).StatusCode);

        // an enrolled device wraps the CSK to dev-b
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync($"{Devices}/dev-b/wrap", new { wrappedCsk = "wrapped-for-b" })).StatusCode);
        var wrap = await Json(await client.GetAsync($"{Devices}/dev-b/wrap"));
        Assert.Equal("wrapped-for-b", wrap.GetProperty("wrappedCsk").GetString());

        // the device list reports approval state
        var devices = await Json(await client.GetAsync(Devices));
        Assert.Equal(2, devices.GetArrayLength());
        Assert.Contains(devices.EnumerateArray(), d => d.GetProperty("deviceId").GetString() == "dev-b" && d.GetProperty("hasWrap").GetBoolean());
    }

    [Fact]
    public async Task ReinstallWithNewKey_InvalidatesTheOldWrap()
    {
        var client = await ClientFor("sync-bob");
        await client.PostAsJsonAsync(Devices, new { deviceId = "dev-x", publicJwk = "{jwk-1}", name = "Phone" });
        await client.PostAsJsonAsync($"{Devices}/dev-x/wrap", new { wrappedCsk = "old-wrap" });
        // fresh install, fresh keypair — the stale wrap must die with it
        await client.PostAsJsonAsync(Devices, new { deviceId = "dev-x", publicJwk = "{jwk-2}", name = "Phone" });
        Assert.Equal(HttpStatusCode.NoContent, (await client.GetAsync($"{Devices}/dev-x/wrap")).StatusCode);
    }

    [Fact]
    public async Task Ciphertext_RoundTrips_KeyedByConnection_AndStaysPerUser()
    {
        var alice = await ClientFor("sync-carol");
        var mallory = await ClientFor("sync-mallory");
        // one bundle blob per connection, keyed by the relay's connection id
        var connectionId = Guid.NewGuid().ToString();
        Assert.Equal(HttpStatusCode.OK, (await alice.PutAsJsonAsync($"{Connections}/{connectionId}", new { cipher = "opaque-blob" })).StatusCode);

        var mine = await Json(await alice.GetAsync(Connections));
        Assert.Equal(1, mine.GetArrayLength());
        Assert.Equal(connectionId, mine[0].GetProperty("connectionId").GetString());
        Assert.Equal("opaque-blob", mine[0].GetProperty("cipher").GetString());

        var theirs = await Json(await mallory.GetAsync(Connections));
        Assert.Equal(0, theirs.GetArrayLength());
    }

    [Fact]
    public async Task MalformedConnectionId_IsRefused()
    {
        var client = await ClientFor("sync-erin");
        // the id must be the relay's shape: no spaces, at most 64 chars
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync($"{Connections}/has id", new { cipher = "blob" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync($"{Connections}/{new string('a', 65)}", new { cipher = "blob" })).StatusCode);
        Assert.Equal(0, (await Json(await client.GetAsync(Connections))).GetArrayLength());
    }

    [Fact]
    public async Task GlobalOff_ErasesEverything()
    {
        var client = await ClientFor("sync-dave");
        await client.PostAsJsonAsync(Devices, new { deviceId = "dev-1", publicJwk = "{jwk}", name = "Phone" });
        await client.PutAsJsonAsync($"{Connections}/{Guid.NewGuid()}", new { cipher = "blob" });

        Assert.Equal(HttpStatusCode.OK, (await client.DeleteAsync(Root)).StatusCode);
        Assert.Equal(0, (await Json(await client.GetAsync(Devices))).GetArrayLength());
        Assert.Equal(0, (await Json(await client.GetAsync(Connections))).GetArrayLength());
    }
}
