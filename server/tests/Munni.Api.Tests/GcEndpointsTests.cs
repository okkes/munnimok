using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Data;
using Munni.Api.GoCardless;
using Munni.Api.Logos;
using Munni.Api.Social;

namespace Munni.Api.Tests;

/// <summary>Scriptable IGoCardlessApi — records calls, returns canned data.</summary>
public sealed class FakeGoCardlessApi : IGoCardlessApi
{
    public int InstitutionCalls;
    public List<string> DeletedRequisitions { get; } = [];
    public GcRequisitionStatus Status { get; set; } = new("gc-req-1", "LN", ["gc-acc-1"]);
    public GcAccountDetails Details { get; set; } = new("NL69INGB0123456789", "Betaalrekening", "EUR");

    public Task<IReadOnlyList<GcInstitution>> GetInstitutionsAsync(string country, CancellationToken ct = default)
    {
        InstitutionCalls++;
        return Task.FromResult<IReadOnlyList<GcInstitution>>([new GcInstitution("ING_NL", "ING", "INGBNL2A", "730", null)]);
    }

    public Task<GcRequisitionCreated> CreateRequisitionAsync(string institutionId, string redirect, string reference, CancellationToken ct = default) =>
        Task.FromResult(new GcRequisitionCreated("gc-req-1", $"https://gc.example/authorize/{reference}", "CR"));

    public Task<GcRequisitionStatus> GetRequisitionAsync(string requisitionId, CancellationToken ct = default) =>
        Task.FromResult(Status);

    public Task<IReadOnlyList<GcRequisitionListItem>> ListRequisitionsAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<GcRequisitionListItem>>([]);

    public Task DeleteRequisitionAsync(string requisitionId, CancellationToken ct = default)
    {
        DeletedRequisitions.Add(requisitionId);
        return Task.CompletedTask;
    }

    public Task<GcAccountDetails> GetAccountDetailsAsync(string gcAccountId, CancellationToken ct = default) =>
        Task.FromResult(Details);

    public Task<IReadOnlyList<GcBalance>> GetBalancesAsync(string gcAccountId, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<GcBalance>>([new GcBalance(new GcAmount("1234.56", "EUR"), "closingBooked")]);

    public List<DateOnly?> TransactionFroms { get; } = [];
    public List<GcTransaction> Pending { get; set; } = [];
    public GcRateInfo? Rate { get; set; }

    public Task<GcTransactionsPage> GetTransactionsAsync(string gcAccountId, DateOnly? from, CancellationToken ct = default)
    {
        TransactionFroms.Add(from);
        return Task.FromResult(new GcTransactionsPage(
            [new GcTransaction("BANKREF-1", null, "2026-07-05", null, new GcAmount("-42.10", "EUR"), "Albert Heijn", null, "AH 1350")],
            Pending,
            Rate));
    }
}

/// <summary>logo.dev search stub for the named HttpClient.</summary>
file sealed class FakeLogoHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var q = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["q"];
        if (q == "boom") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadGateway));
        var body = """[{"name":"Netflix","domain":"netflix.com"},{"name":"NoDomain","domain":null}]""";
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        });
    }
}

/// <summary>Factory with GoCardless + logo.dev enabled and both vendors faked.</summary>
public class GcApiFactory : WebApplicationFactory<Program>
{
    public FakeGoCardlessApi Gc { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("environment", "Development");
        builder.UseSetting("GoCardless:SecretId", "test-id");
        builder.UseSetting("GoCardless:SecretKey", "test-key");
        builder.UseSetting("Logos:SecretKey", "logo-secret");
        builder.UseSetting("Logos:PublicToken", "pk_test");
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
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("gc-endpoint-tests"));

            // the scheduled fetch loop must not run during tests
            foreach (var d in services.Where(d => d.ImplementationType == typeof(GcFetchService)).ToList())
            {
                services.Remove(d);
            }
            services.AddSingleton<IGoCardlessApi>(Gc);
            services.AddHttpClient(LogoEndpoints.HttpClientName)
                .ConfigurePrimaryHttpMessageHandler(() => new FakeLogoHandler());
        });
    }
}

public class GcEndpointsTests : IClassFixture<GcApiFactory>
{
    private readonly GcApiFactory _factory;

    public GcEndpointsTests(GcApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        return client;
    }

    private async Task<(HttpClient client, Guid userId, string spaceId)> MemberAsync(string suffix)
    {
        var client = ClientFor($"gc-{suffix}");
        var me = await client.GetFromJsonAsync<MeResponse>("/me");
        var spaceId = $"space_gc_{suffix}";
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Spaces.Add(new Space { Id = spaceId });
        db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = me!.UserId, Role = SpaceRoles.Owner });
        await db.SaveChangesAsync();
        return (client, me.UserId, spaceId);
    }

    [Fact]
    public async Task Institutions_validate_country_and_cache_the_vendor_call()
    {
        var client = ClientFor("gc-inst");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/gocardless/institutions?country=nether")).StatusCode);

        var before = _factory.Gc.InstitutionCalls;
        var list = await client.GetFromJsonAsync<List<GcInstitution>>("/gocardless/institutions?country=nl");
        Assert.Equal("ING_NL", Assert.Single(list!).Id);
        await client.GetAsync("/gocardless/institutions?country=nl");
        Assert.Equal(before + 1, _factory.Gc.InstitutionCalls); // second hit served from cache
    }

    [Fact]
    public async Task Requisition_flow_is_member_gated_and_complete_ingests_into_the_feed()
    {
        var (client, _, spaceId) = await MemberAsync("flow");

        // non-members may not connect a bank to the space
        var outsider = ClientFor("gc-outsider");
        Assert.Equal(HttpStatusCode.Forbidden, (await outsider.PostAsJsonAsync("/gocardless/requisitions",
            new CreateRequisitionRequest(spaceId, "ING_NL", "https://app/gc-callback"))).StatusCode);

        var created = await (await client.PostAsJsonAsync("/gocardless/requisitions",
            new CreateRequisitionRequest(spaceId, "ING_NL", "https://app/gc-callback"))).Content
            .ReadFromJsonAsync<CreateRequisitionResponse>();
        Assert.Contains(created!.Reference, created.Link);

        // completing an unknown reference is NotFound; the real one ingests
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/gocardless/requisitions/{Guid.NewGuid()}/complete", null)).StatusCode);
        var complete = await (await client.PostAsync($"/gocardless/requisitions/{created.Reference}/complete", null))
            .Content.ReadFromJsonAsync<CompleteResponse>();
        Assert.Equal("LN", complete!.Status);
        Assert.Equal(1, complete.LinkedAccounts);
        Assert.True(complete.ImportedTransactions > 0);

        // the account link is visible in /connections for the member
        var connections = await client.GetFromJsonAsync<List<Dictionary<string, object?>>>("/gocardless/connections");
        Assert.Contains(connections!, c => (c["iban"]?.ToString() ?? "") == "NL69INGB0123456789");
        Assert.Empty((await outsider.GetFromJsonAsync<List<Dictionary<string, object?>>>("/gocardless/connections"))!);
    }

    [Fact]
    public async Task Complete_reports_a_pending_bank_without_ingesting()
    {
        var (client, _, spaceId) = await MemberAsync("pending");
        var created = await (await client.PostAsJsonAsync("/gocardless/requisitions",
            new CreateRequisitionRequest(spaceId, "ING_NL", "https://app/gc-callback"))).Content
            .ReadFromJsonAsync<CreateRequisitionResponse>();

        _factory.Gc.Status = new GcRequisitionStatus("gc-req-1", "GA", []);
        try
        {
            var complete = await (await client.PostAsync($"/gocardless/requisitions/{created!.Reference}/complete", null))
                .Content.ReadFromJsonAsync<CompleteResponse>();
            Assert.Equal("GA", complete!.Status);
            Assert.Equal(0, complete.LinkedAccounts);
        }
        finally
        {
            _factory.Gc.Status = new GcRequisitionStatus("gc-req-1", "LN", ["gc-acc-1"]);
        }
    }

    [Fact]
    public async Task FetchService_ingests_stale_accounts_and_skips_recently_fetched_ones()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var spaceId = $"space_fetch_{suffix}";
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Spaces.Add(new Space { Id = spaceId });
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = Guid.NewGuid(), UserId = Guid.NewGuid(), SpaceId = spaceId,
                InstitutionId = "ING_NL", RequisitionId = $"req-{suffix}", Status = "linked",
            });
            db.GcLinkedAccounts.Add(new GcLinkedAccount
            {
                GcAccountId = $"gc-fetch-{suffix}", SpaceId = spaceId,
                AccountEntityId = ImportIds.AccountId("NL69INGB0123456789"),
                Iban = "NL69INGB0123456789", Currency = "EUR",
                RequisitionId = db.GcRequisitions.Local.First().Id,
            });
            await db.SaveChangesAsync();
        }

        var service = new GcFetchService(
            _factory.Services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<GcFetchService>.Instance)
        { AccountDelay = TimeSpan.Zero };
        await service.FetchAllAsync(CancellationToken.None);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var linked = await db.GcLinkedAccounts.FindAsync($"gc-fetch-{suffix}");
            Assert.NotNull(linked!.LastFetchAt); // fetched + stamped
            // raw rows landed in the account's FEED space
            var feedId = ImportIds.FeedSpaceId("NL69INGB0123456789");
            Assert.True(await db.EntityRows.AnyAsync(r => r.SpaceId == feedId && r.Entity == "transaction"));
        }

        // a second run within 5h must skip the account (LastFetchAt fresh)
        var callsBefore = _factory.Gc.InstitutionCalls; // unrelated counter guard
        await service.FetchAllAsync(CancellationToken.None);
        Assert.Equal(callsBefore, _factory.Gc.InstitutionCalls);
    }

    [Fact]
    public async Task FetchService_backfills_full_history_once_for_pre_feed_accounts()
    {
        // an account linked BEFORE the feed-space migration: LastFetchAt is
        // set (so the naive delta would be tiny) but the feed never saw the
        // 90-day window — HistoryBackfilledAt null must force it (user bug:
        // attaching such an account showed only ~a week of history)
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var spaceId = $"space_backfill_{suffix}";
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Spaces.Add(new Space { Id = spaceId });
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = Guid.NewGuid(), UserId = Guid.NewGuid(), SpaceId = spaceId,
                InstitutionId = "ING_NL", RequisitionId = $"req-bf-{suffix}", Status = "linked",
            });
            db.GcLinkedAccounts.Add(new GcLinkedAccount
            {
                GcAccountId = $"gc-bf-{suffix}", SpaceId = spaceId,
                AccountEntityId = ImportIds.AccountId("NL20INGB0001234567"),
                Iban = "NL20INGB0001234567", Currency = "EUR",
                RequisitionId = db.GcRequisitions.Local.First().Id,
                LastFetchAt = DateTimeOffset.UtcNow.AddDays(-2), // stale enough to be due
            });
            await db.SaveChangesAsync();
        }

        var service = new GcFetchService(
            _factory.Services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<GcFetchService>.Instance)
        { AccountDelay = TimeSpan.Zero };
        var callsBefore = _factory.Gc.TransactionFroms.Count;
        // FetchAccountAsync directly: FetchAllAsync's IsDue gate only opens
        // in the bank's 03:00 hour, which would make this test time-of-day
        // dependent
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var linked = await db.GcLinkedAccounts.FindAsync($"gc-bf-{suffix}");
            await service.FetchAccountAsync(scope.ServiceProvider, db, _factory.Gc, linked!, CancellationToken.None);
        }

        var from = _factory.Gc.TransactionFroms[callsBefore];
        Assert.True(from <= DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-89)), $"expected full-window fetch, got {from}");
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var linked = await db.GcLinkedAccounts.FindAsync($"gc-bf-{suffix}");
            Assert.NotNull(linked!.HistoryBackfilledAt); // one-time: stamped after the backfill
        }
    }

    [Fact]
    public async Task Pending_transactions_mirror_into_the_feed_and_vanish_when_no_longer_pending()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var spaceId = $"space_pending_{suffix}";
        var iban = "NL30INGB0009876543";
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Spaces.Add(new Space { Id = spaceId });
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = Guid.NewGuid(), UserId = Guid.NewGuid(), SpaceId = spaceId,
                InstitutionId = "ING_NL", RequisitionId = $"req-p-{suffix}", Status = "linked",
            });
            db.GcLinkedAccounts.Add(new GcLinkedAccount
            {
                GcAccountId = $"gc-p-{suffix}", SpaceId = spaceId,
                AccountEntityId = ImportIds.AccountId(iban),
                Iban = iban, Currency = "EUR",
                RequisitionId = db.GcRequisitions.Local.First().Id,
            });
            await db.SaveChangesAsync();
        }

        var service = new GcFetchService(
            _factory.Services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<GcFetchService>.Instance)
        { AccountDelay = TimeSpan.Zero };
        var pendingEntityId = ImportIds.TransactionId(iban, "pending:PND-1");
        var feedId = ImportIds.FeedSpaceId(iban);

        async Task FetchOnce()
        {
            using var scope = _factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var linked = await db.GcLinkedAccounts.FindAsync($"gc-p-{suffix}");
            await service.FetchAccountAsync(scope.ServiceProvider, db, _factory.Gc, linked!, CancellationToken.None);
        }

        _factory.Gc.Pending = [new GcTransaction(null, "PND-1", null, "2026-07-13", new GcAmount("-15.00", "EUR"), "Tikkie", null, "reserved")];
        try
        {
            await FetchOnce();
            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var row = await db.EntityRows.FindAsync(feedId, "transaction", pendingEntityId);
                Assert.NotNull(row);
                Assert.False(row!.Deleted);
                Assert.Contains("\"pending\":1", row.DataJson);
                Assert.True(await db.GcPendingTxs.AnyAsync(p => p.EntityId == pendingEntityId));
            }

            // next fetch: the charge left the pending list (it booked) — the
            // mirrored pending row gets tombstoned
            _factory.Gc.Pending = [];
            await FetchOnce();
            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var row = await db.EntityRows.FindAsync(feedId, "transaction", pendingEntityId);
                Assert.True(row!.Deleted);
                Assert.False(await db.GcPendingTxs.AnyAsync(p => p.EntityId == pendingEntityId));
            }
        }
        finally
        {
            _factory.Gc.Pending = [];
        }
    }

    [Fact]
    public async Task Cleanup_frees_idle_requisitions_but_keeps_fresh_and_linked_ones()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var abandonedId = Guid.NewGuid();
        var freshId = Guid.NewGuid();
        var linkedId = Guid.NewGuid();
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            // abandoned consent journey, past the grace window → cleaned
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = abandonedId, UserId = Guid.NewGuid(), SpaceId = $"space_cl_{suffix}",
                InstitutionId = "ING_NL", RequisitionId = $"req-idle-{suffix}", Status = "created",
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-5),
            });
            // just started — the user may still be at the bank → kept
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = freshId, UserId = Guid.NewGuid(), SpaceId = $"space_cl_{suffix}",
                InstitutionId = "ING_NL", RequisitionId = $"req-fresh-{suffix}", Status = "created",
            });
            // old but feeding a linked account → kept
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = linkedId, UserId = Guid.NewGuid(), SpaceId = $"space_cl_{suffix}",
                InstitutionId = "ING_NL", RequisitionId = $"req-live-{suffix}", Status = "linked",
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-40),
            });
            db.GcLinkedAccounts.Add(new GcLinkedAccount
            {
                GcAccountId = $"gc-clean-{suffix}", SpaceId = $"space_cl_{suffix}",
                AccountEntityId = ImportIds.AccountId("NL10RABO0123456789"),
                Iban = "NL10RABO0123456789", Currency = "EUR",
                RequisitionId = linkedId, LastFetchAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var service = new GcFetchService(
            _factory.Services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<GcFetchService>.Instance);
        await service.CleanupIdleRequisitionsAsync(CancellationToken.None);

        Assert.Contains($"req-idle-{suffix}", _factory.Gc.DeletedRequisitions);
        Assert.DoesNotContain($"req-fresh-{suffix}", _factory.Gc.DeletedRequisitions);
        Assert.DoesNotContain($"req-live-{suffix}", _factory.Gc.DeletedRequisitions);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Null(await db.GcRequisitions.FindAsync(abandonedId));
            Assert.NotNull(await db.GcRequisitions.FindAsync(freshId));
            Assert.NotNull(await db.GcRequisitions.FindAsync(linkedId));
        }
    }

    [Fact]
    public async Task Logo_search_maps_results_and_survives_upstream_failure()
    {
        var client = ClientFor("gc-logos");
        var results = await client.GetFromJsonAsync<List<LogoResult>>("/logos/search?q=netflix");
        var hit = Assert.Single(results!); // the domain-less entry is dropped
        Assert.Equal("netflix.com", hit.Domain);
        Assert.Contains("img.logo.dev/netflix.com", hit.LogoUrl);
        Assert.Contains("token=pk_test", hit.LogoUrl);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/logos/search?q=a")).StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<List<LogoResult>>("/logos/search?q=boom"))!);
    }

    [Fact]
    public async Task Logo_health_reports_a_working_configuration()
    {
        var client = ClientFor("gc-logos-health");
        var health = await client.GetFromJsonAsync<JsonElement>("/logos/health");
        Assert.True(health.GetProperty("configured").GetBoolean());
        Assert.Equal("ok", health.GetProperty("search").GetString());
        Assert.False(health.GetProperty("secretLooksSwapped").GetBoolean());
    }
}
