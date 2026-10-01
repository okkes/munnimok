using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Admin;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Tests;

/// <summary>
/// Test host for the admin area. One in-memory database PER FIXTURE
/// INSTANCE: EF's internal service-provider cache is process-wide and
/// keyed by the options, so two fixtures naming the same database share
/// one store — AccountDeletionTests seeded rows into this class's
/// assertions whenever xUnit ran the classes in parallel (the ~50 % flake
/// on dev).
/// </summary>
public class AdminApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databaseName = $"admin-tests-{Guid.NewGuid():N}";

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
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));
        });
    }
}

/// <summary>
/// The admin area is gated by the token's `admin` scope (AdminScope): the
/// subject is anyone, the scope decides — exactly what Logto issues when
/// the user holds the admin role on the API resource.
/// </summary>
public class AdminEndpointsTests : IClassFixture<AdminApiFactory>
{
    private readonly AdminApiFactory _factory;

    public AdminEndpointsTests(AdminApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub, string? scope = null)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    [Fact]
    public async Task The_scope_grants_admin_not_the_subject()
    {
        // the same subject: no scope → 403, the scope among others → 200
        Assert.Equal(HttpStatusCode.Forbidden, (await ClientFor("the-admin").GetAsync("/admin/ping")).StatusCode);
        var response = await ClientFor("the-admin", "openid profile admin").GetAsync("/admin/ping");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.True(body.GetProperty("admin").GetBoolean());

        // whole-word scope: look-alikes do not count
        Assert.Equal(HttpStatusCode.Forbidden, (await ClientFor("the-admin", "administrator").GetAsync("/admin/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ClientFor("the-admin", "admin:read").GetAsync("/admin/ping")).StatusCode);
        // no session at all → 401, not 403
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync("/admin/ping")).StatusCode);
    }

    [Fact]
    public void A_scope_claim_split_into_several_claims_still_counts()
    {
        // a JSON-array `scope` deserializes as one claim per entry
        var arrayShaped = new ClaimsPrincipal(new ClaimsIdentity([new Claim("scope", "openid"), new Claim("scope", "admin")], "test"));
        Assert.True(AdminScope.HasAdminScope(arrayShaped));
        var stringShaped = new ClaimsPrincipal(new ClaimsIdentity([new Claim("scope", "openid admin")], "test"));
        Assert.True(AdminScope.HasAdminScope(stringShaped));
        Assert.False(AdminScope.HasAdminScope(new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "x")], "test"))));
    }

    [Fact]
    public async Task User_diagnosis_exposes_the_whole_sync_chain()
    {
        var admin = ClientFor("the-admin", "admin");
        var user = ClientFor("diag-user");
        await user.GetAsync("/me"); // materialize

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var userId = (await db.Users.FirstAsync(u => u.Sub == "diag-user")).Id;
            db.Spaces.Add(new Space { Id = "space-diag" });
            db.SpaceMembers.Add(new SpaceMember { SpaceId = "space-diag", UserId = userId, Role = Social.SpaceRoles.Owner });
            db.FeedSpaces.Add(new Accounts.FeedSpace { Id = "feed-diag", OwnerUserId = userId, AccountRef = "NL01TEST" });
            db.SpaceAccountLinks.Add(new Accounts.SpaceAccountLink
            {
                Id = Guid.NewGuid(), SpaceId = "space-diag", FeedSpaceId = "feed-diag", AccountId = "acct-1", AttachedBy = userId,
                HistoryFrom = "2026-01-01", Type = "checking",
            });
            await db.SaveChangesAsync();
        }

        var res = await admin.GetAsync("/admin/users/diag-user/diagnosis");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;
        Assert.Contains("space-diag", body.GetProperty("memberSpaces").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("feed-diag", body.GetProperty("ownedFeeds")[0].GetProperty("feedSpaceId").GetString());
        Assert.Equal("feed-diag", body.GetProperty("attachments")[0].GetProperty("feedSpaceId").GetString());
        // a bank's consent is a connector session like any other party's (§15): the list is there, empty here
        Assert.Equal(JsonValueKind.Array, body.GetProperty("connectorSessions").ValueKind);

        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/admin/users/nobody/diagnosis")).StatusCode);
    }

    [Fact]
    public async Task NonAdminIsForbiddenEverywhere()
    {
        var user = ClientFor("regular-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/users")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/users/regular-user/diagnosis")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync("/admin/users/regular-user")).StatusCode);
    }

    [Fact]
    public async Task The_old_open_banking_routes_are_gone()
    {
        // §15.8: the api's own requisition management and quota snapshots retired with the parties' move to the platform
        var admin = ClientFor("the-admin", "admin");
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/admin/gocardless/requisitions")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/admin/quota")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/control/quota")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/control/consents")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ClientFor("someone").GetAsync("/gocardless/institutions?country=NL")).StatusCode);
    }

    [Fact]
    public async Task UsersListCountsBankFeedsApartFromSpaces()
    {
        var admin = ClientFor("the-admin-feeds", "admin");
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var owner = new User { Id = Guid.NewGuid(), Sub = "the-feed-owner" };
            db.Users.Add(owner);
            db.Spaces.Add(new Space { Id = "space-personal-feeds" });
            db.FeedSpaces.Add(new Munni.Api.Accounts.FeedSpace { Id = "feed-1", OwnerUserId = owner.Id, AccountRef = "NL00TEST0000000001" });
            db.FeedSpaces.Add(new Munni.Api.Accounts.FeedSpace { Id = "feed-2", OwnerUserId = owner.Id, AccountRef = "NL00TEST0000000002" });
            foreach (var spaceId in new[] { "space-personal-feeds", "feed-1", "feed-2" })
                db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = owner.Id, Role = Munni.Api.Social.SpaceRoles.Owner });
            await db.SaveChangesAsync();
        }
        var users = await admin.GetFromJsonAsync<List<AdminUserDto>>("/admin/users");
        var me = users!.Single(u => u.Sub == "the-feed-owner");
        // one personal space + a bank connection with two accounts: 1 space and 2 feeds, not "3 spaces"
        Assert.Equal(1, me.SpaceCount);
        Assert.Equal(2, me.FeedCount);
    }
}
