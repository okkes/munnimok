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
using Munni.Api.GoCardless;

namespace Munni.Api.Tests;

/// <summary>Fake GoCardless with two requisitions, one unknown locally (stale).</summary>
public sealed class FakeGoCardless : IGoCardlessApi
{
    public List<string> Deleted { get; } = [];
    public List<GcRequisitionListItem> Requisitions { get; } =
    [
        new("req-known", "LN", "ING_INGBNL2A", DateTimeOffset.UtcNow.AddDays(-2), null, ["acc-1"]),
        new("req-stale", "CR", "ING_INGBNL2A", DateTimeOffset.UtcNow.AddDays(-9), null, []),
    ];

    public Task<IReadOnlyList<GcRequisitionListItem>> ListRequisitionsAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<GcRequisitionListItem>>(Requisitions);

    public Task DeleteRequisitionAsync(string requisitionId, CancellationToken ct = default)
    {
        Deleted.Add(requisitionId);
        Requisitions.RemoveAll(r => r.Id == requisitionId);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<GcInstitution>> GetInstitutionsAsync(string country, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<GcInstitution>>([]);
    public Task<GcRequisitionCreated> CreateRequisitionAsync(string institutionId, string redirect, string reference, CancellationToken ct = default) =>
        throw new NotImplementedException();
    public Task<GcRequisitionStatus> GetRequisitionAsync(string requisitionId, CancellationToken ct = default) =>
        throw new NotImplementedException();
    public Task<GcAccountDetails> GetAccountDetailsAsync(string gcAccountId, CancellationToken ct = default) =>
        throw new NotImplementedException();
    public Task<IReadOnlyList<GcBalance>> GetBalancesAsync(string gcAccountId, CancellationToken ct = default) =>
        throw new NotImplementedException();
    public Task<GcTransactionsPage> GetTransactionsAsync(string gcAccountId, DateOnly? from, CancellationToken ct = default) =>
        throw new NotImplementedException();
}

/// <summary>
/// Test host with GoCardless faked. One in-memory database PER FIXTURE
/// INSTANCE: EF's internal service-provider cache is process-wide and
/// keyed by the options, so two fixtures naming the same database share
/// one store — AccountDeletionTests seeded requisitions into this class's
/// "2 rows" assertion whenever xUnit ran the classes in parallel (the
/// ~50 % flake on dev).
/// </summary>
public class AdminApiFactory : WebApplicationFactory<Program>
{
    public FakeGoCardless Gc { get; } = new();
    private readonly string _databaseName = $"admin-tests-{Guid.NewGuid():N}";

    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("GoCardless:SecretId", "test"); // enables admin GC routes
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType == typeof(IGoCardlessApi) ||
                             d.ServiceType == typeof(Microsoft.Extensions.Hosting.IHostedService) && d.ImplementationType == typeof(GcFetchService) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));
            services.AddSingleton<IGoCardlessApi>(Gc);
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
        Assert.True(body.GetProperty("gocardless").GetBoolean());

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

        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/admin/users/nobody/diagnosis")).StatusCode);
    }

    [Fact]
    public async Task NonAdminIsForbiddenEverywhere()
    {
        var user = ClientFor("regular-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/users")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/users/regular-user/diagnosis")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/quota")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/gocardless/requisitions")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync("/admin/gocardless/requisitions/req-x")).StatusCode);
    }

    [Fact]
    public async Task AdminSeesOnlyThisEnvironmentsRequisitions_ForeignOnesAreCountedAndUndeletable()
    {
        var admin = ClientFor("the-admin", "admin");
        Assert.True((await admin.GetAsync("/admin/ping")).IsSuccessStatusCode);

        // seed local records: one matching req-known (also present at GC)
        // and one the provider no longer knows (dead consent → stale)
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var owner = new User { Id = Guid.NewGuid(), Sub = "the-owner" };
            db.Users.Add(owner);
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = Guid.NewGuid(),
                UserId = owner.Id,
                SpaceId = "s1",
                InstitutionId = "ING_INGBNL2A",
                RequisitionId = "req-known",
                Status = "linked",
            });
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = Guid.NewGuid(),
                UserId = owner.Id,
                SpaceId = "s1",
                InstitutionId = "ASN_BANK_ASNBNL21",
                RequisitionId = "req-dead-at-gc",
                Status = "created",
            });
            await db.SaveChangesAsync();
        }

        var users = await admin.GetFromJsonAsync<List<AdminUserDto>>("/admin/users");
        Assert.Contains(users!, u => u.Sub == "the-owner");

        // the shared GC account also carries req-stale (another
        // environment's consent) — counted, never listed
        var list = await admin.GetFromJsonAsync<AdminRequisitionListDto>("/admin/gocardless/requisitions");
        Assert.Equal(2, list!.Requisitions.Count);
        Assert.Equal(1, list.ForeignCount);
        Assert.DoesNotContain(list.Requisitions, r => r.RequisitionId == "req-stale");
        var known = list.Requisitions.Single(r => r.RequisitionId == "req-known");
        Assert.False(known.Stale);
        Assert.Equal("the-owner", known.OwnerSub);
        var dead = list.Requisitions.Single(r => r.RequisitionId == "req-dead-at-gc");
        Assert.True(dead.Stale);
        Assert.Equal("gone", dead.Status);

        // deleting a FOREIGN consent is refused and GC is never called —
        // a staging admin must not be able to revoke prod's bank access
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync("/admin/gocardless/requisitions/req-stale")).StatusCode);
        Assert.DoesNotContain("req-stale", _factory.Gc.Deleted);

        // deleting an OWN consent works: GC called, list shrinks
        Assert.True((await admin.DeleteAsync("/admin/gocardless/requisitions/req-known")).IsSuccessStatusCode);
        Assert.Contains("req-known", _factory.Gc.Deleted);
        var after = await admin.GetFromJsonAsync<AdminRequisitionListDto>("/admin/gocardless/requisitions");
        Assert.Single(after!.Requisitions);
    }

    [Fact]
    public async Task QuotaEndpointReturnsCapturedSnapshots()
    {
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.ProviderQuotas.Add(new ProviderQuota
            {
                Id = Guid.NewGuid(),
                Provider = "gocardless",
                Scope = "accounts:transactions",
                Limit = 4,
                Remaining = 3,
                ResetAtUtc = DateTimeOffset.UtcNow.AddHours(20),
            });
            await db.SaveChangesAsync();
        }
        var admin = ClientFor("the-admin", "admin");
        var quota = await admin.GetFromJsonAsync<List<ProviderQuotaDto>>("/admin/quota");
        var row = quota!.Single(q => q.Scope == "accounts:transactions");
        Assert.Equal(4, row.Limit);
        Assert.Equal(3, row.Remaining);
    }
}

public class QuotaCaptureHandlerTests
{
    [Theory]
    [InlineData("https://x/api/v2/requisitions/", "requisitions")]
    [InlineData("https://x/api/v2/accounts/abc-123/transactions/", "accounts:transactions")]
    [InlineData("https://x/api/v2/accounts/abc-123/details/", "accounts:details")]
    [InlineData("https://x/api/v2/token/new/", "token:new")]
    public void ScopeCollapsesIdsIntoEndpointFamilies(string url, string expected) =>
        Assert.Equal(expected, QuotaCaptureHandler.ScopeOf(new Uri(url)));
}
