using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Auth;
using Munni.Api.Data;
using Xunit;

namespace Munni.Api.Tests;

public class DevicesApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("device-tests"));
        });
    }
}

/// <summary>
/// Logged-in devices: every authenticated request names its device (or
/// is refused), stamping, list/rename, and the remote-disconnect contract
/// (revoked device → 410, so the client wipes itself — 403 would read as
/// a lost space membership).
/// </summary>
public class DeviceEndpointsTests : IClassFixture<DevicesApiFactory>
{
    private readonly DevicesApiFactory _factory;

    public DeviceEndpointsTests(DevicesApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub, string? deviceId = null, string? platform = null)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        if (deviceId is not null) client.DefaultRequestHeaders.Add("X-Munni-Device", deviceId);
        if (platform is not null) client.DefaultRequestHeaders.Add("X-Munni-Platform", platform);
        return client;
    }

    [Fact]
    public async Task Requests_stamp_the_calling_device_and_the_list_shows_it()
    {
        var sub = $"dev_{Guid.NewGuid():N}";
        var phone = ClientFor(sub, "phone-1", "android");
        var devices = await phone.GetFromJsonAsync<List<DeviceDto>>("/me/devices");
        Assert.Contains(devices!, d => d.Id == "phone-1" && d.Platform == "android" && !d.Revoked);
    }

    [Fact]
    public async Task Renaming_persists()
    {
        var sub = $"dev_{Guid.NewGuid():N}";
        var phone = ClientFor(sub, "phone-2", "ios");
        await phone.GetAsync("/me/devices"); // stamps the row

        var rename = await phone.PatchAsJsonAsync("/me/devices/phone-2", new RenameDeviceRequest("Okkes' iPhone"));
        Assert.Equal(HttpStatusCode.OK, rename.StatusCode);
        var devices = await phone.GetFromJsonAsync<List<DeviceDto>>("/me/devices");
        Assert.Contains(devices!, d => d.Id == "phone-2" && d.Name == "Okkes' iPhone");
    }

    [Fact]
    public async Task A_request_that_names_no_device_is_refused()
    {
        // every client has a device id (the HLC node id); without one the
        // server could never disconnect it, so the request is refused —
        // 401 with its own reason, distinct from an expired session
        var sub = $"dev_{Guid.NewGuid():N}";
        var refused = await ClientFor(sub).GetAsync("/me/devices");
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.Contains("device-required", await refused.Content.ReadAsStringAsync());
        // an over-long id is no id either
        Assert.Equal(HttpStatusCode.Unauthorized, (await ClientFor(sub, new string('x', 65)).GetAsync("/me/devices")).StatusCode);
        // nothing was stamped for the refused calls
        var devices = await ClientFor(sub, "phone-4", "android").GetFromJsonAsync<List<DeviceDto>>("/me/devices");
        Assert.Equal("phone-4", Assert.Single(devices!).Id);
    }

    [Fact]
    public async Task A_revoked_device_gets_410_on_its_next_request_and_others_keep_working()
    {
        var sub = $"dev_{Guid.NewGuid():N}";
        var phone = ClientFor(sub, "phone-3", "android");
        var laptop = ClientFor(sub, "laptop-3", "web");
        await phone.GetAsync("/me/devices");
        await laptop.GetAsync("/me/devices");

        // the laptop disconnects the phone
        Assert.Equal(HttpStatusCode.OK, (await laptop.PostAsync("/me/devices/phone-3/revoke", null)).StatusCode);

        var refused = await phone.GetAsync("/me/devices");
        Assert.Equal(HttpStatusCode.Gone, refused.StatusCode);
        Assert.Contains("device-revoked", await refused.Content.ReadAsStringAsync());

        // the laptop is untouched and sees the phone marked revoked
        var devices = await laptop.GetFromJsonAsync<List<DeviceDto>>("/me/devices");
        Assert.Contains(devices!, d => d.Id == "phone-3" && d.Revoked);
        // revoking an unknown device 404s
        Assert.Equal(HttpStatusCode.NotFound, (await laptop.PostAsync("/me/devices/ghost/revoke", null)).StatusCode);
    }
}
