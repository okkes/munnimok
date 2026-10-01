using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;

namespace Munni.Api.Tests;

public class ControlApiFactory : WebApplicationFactory<Program>
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
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("control-tests"));
        });
    }
}

/// <summary>/control shares the `admin` scope gate with /admin (AdminScope); the cockpit reads the
/// connector control plane through /control/connectors/* (ConnectorOpenBankingTests walks a live one).</summary>
public class ControlEndpointsTests : IClassFixture<ControlApiFactory>
{
    private readonly ControlApiFactory _factory;

    public ControlEndpointsTests(ControlApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub, string? scope = null)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    [Fact]
    public async Task NonAdminIsForbidden()
    {
        // the connector routes under /control exist only where a control plane is named (ConnectorOpenBankingTests walks them)
        var user = ClientFor("regular-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/control/ping")).StatusCode);
    }

    [Fact]
    public async Task The_ping_answers_the_admin_and_the_cockpit_reads_no_connectors_where_none_run()
    {
        var admin = ClientFor("the-admin", "admin");
        var ping = await admin.GetAsync("/control/ping");
        Assert.Equal(HttpStatusCode.OK, ping.StatusCode);
        Assert.True(JsonDocument.Parse(await ping.Content.ReadAsStringAsync()).RootElement.GetProperty("admin").GetBoolean());

        // this host names no control plane: the cockpit's connector routes answer 404, which the cockpit reads as "runs no connectors"
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/control/connectors/status")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/control/connectors/providers/gocardless/remote-consents")).StatusCode);
        // the cockpit never revokes: no delete route under /control
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync("/control/connectors/providers/gocardless/remote-consents/c1")).StatusCode);
    }
}
