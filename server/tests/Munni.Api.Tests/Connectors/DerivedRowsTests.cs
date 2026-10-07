using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Accounts;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Sync;
using Xunit;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// Rows whose id the connector derived (2026-10-07: ING's card repayments
/// landed twice after a new sign-in): the reconciler lands a re-keyed row
/// on the row it is the same transaction as, and the one-time repair takes
/// the copies already there back out - the untouched ones first.
/// </summary>
public class DerivedRowsTests : IClassFixture<FeedsApiFactory>
{
    private readonly FeedsApiFactory _factory;

    public DerivedRowsTests(FeedsApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static Dictionary<string, JsonElement> Fields(params (string Name, object Value)[] fields) =>
        fields.ToDictionary(f => f.Name, f => JsonSerializer.SerializeToElement(f.Value));

    /// <summary>A feed row as the ingest writes it, born at the given wall-clock second (the stamp's first part).</summary>
    private static SyncOpDto FeedRow(string feedId, string id, long bornMs, string account, string date, long cents, string merchant, string reference) =>
        new(Guid.NewGuid().ToString("N"), feedId, "transaction", id,
            Fields(("accountId", account), ("date", date), ("amountCents", cents), ("currency", "EUR"), ("merchant", merchant), ("description", merchant), ("importRef", reference)),
            ServerHlc.Encode(bornMs, 0));

    private static SyncOpDto Meta(string spaceId, string txId, string hlc, params (string Name, object Value)[] fields) =>
        new(Guid.NewGuid().ToString("N"), spaceId, "txMeta", ImportIds.TxMetaId(spaceId, txId), Fields(fields), hlc);

    private static async Task PushAsync(HttpClient client, string spaceId, params SyncOpDto[] ops)
    {
        var response = await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [.. ops]));
        response.EnsureSuccessStatusCode();
    }

    private async Task<T> WithDbAsync<T>(Func<AppDbContext, Task<T>> body)
    {
        using var scope = _factory.Services.CreateScope();
        return await body(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    private static ConnectorAccountRef Reference(string feedId, string accountEntityId) => new()
    {
        Id = $"acc_{Guid.NewGuid():N}",
        UserId = Guid.NewGuid(),
        Provider = "ing-nl",
        ExternalId = "900012345678",
        Currency = "EUR",
        AccountRef = "CONN:ing-nl:900012345678",
        FeedSpaceId = feedId,
        AccountEntityId = accountEntityId,
        SeenAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public async Task A_re_keyed_derived_row_lands_on_the_row_it_is_the_same_transaction_as_and_each_twin_is_taken_once()
    {
        var feedId = $"feed_{Guid.NewGuid():N}";
        var sub = $"derived_{Guid.NewGuid():N}";
        var client = ClientFor(sub);
        const string account = "acct-card";
        await PushAsync(client, feedId, new SyncOpDto(Guid.NewGuid().ToString("N"), feedId, "space", feedId, Fields(("name", "Feed")), "000000100-0000-dev1"));
        // the repayment as the first sign-in keyed it, a second identical one the same day, and an unrelated row
        await PushAsync(client, feedId,
            FeedRow(feedId, "old-1", 1_000_000, account, "2026-10-04", 96_600, "AFLOSSING", "ing-d-aaaa"),
            FeedRow(feedId, "old-2", 1_000_500, account, "2026-10-04", 96_600, "AFLOSSING", "ing-d-bbbb"),
            FeedRow(feedId, "other", 1_001_000, account, "2026-10-04", -2_300, "OPENAI", "ing-d-cccc"));

        var resolved = await WithDbAsync(async db =>
        {
            var reconciler = new DerivedRowReconciler(db, new HashSet<string>(StringComparer.Ordinal) { "stable-3" });
            var reference = Reference(feedId, account);
            var key = DerivedRowReconciler.Key("2026-10-04", 96_600, "EUR", "AFLOSSING");
            return new[]
            {
                await reconciler.ResolveAsync(reference, "stable-1", "ing-d-1111", key, CancellationToken.None),
                await reconciler.ResolveAsync(reference, "stable-2", "ing-d-2222", key, CancellationToken.None),
                // a third identical row this pass: no twin left, so it is new
                await reconciler.ResolveAsync(reference, "stable-3", "ing-d-3333", key, CancellationToken.None),
                // a row of another content: its own id
                await reconciler.ResolveAsync(reference, "stable-4", "ing-d-4444", DerivedRowReconciler.Key("2026-10-05", 96_600, "EUR", "AFLOSSING"), CancellationToken.None),
                // a reference a row already adopted on an earlier pass
                await reconciler.ResolveAsync(reference, "stable-5", "ing-d-cccc", DerivedRowReconciler.Key("2026-10-04", -2_300, "EUR", "OPENAI"), CancellationToken.None),
            };
        });

        Assert.Equal("old-1", resolved[0]);   // the oldest twin first
        Assert.Equal("old-2", resolved[1]);   // the next one, never the same twin twice
        Assert.Equal("stable-3", resolved[2]);
        Assert.Equal("stable-4", resolved[3]);
        Assert.Equal("other", resolved[4]);
    }

    [Fact]
    public async Task The_repair_tombstones_the_copies_a_new_sign_in_left_and_keeps_the_one_the_person_touched()
    {
        var feedId = $"feed_{Guid.NewGuid():N}";
        var spaceId = $"space_{Guid.NewGuid():N}";
        var sub = $"repair_{Guid.NewGuid():N}";
        var client = ClientFor(sub);
        const string account = "acct-card";
        await PushAsync(client, feedId, new SyncOpDto(Guid.NewGuid().ToString("N"), feedId, "space", feedId, Fields(("name", "Feed")), "000000100-0000-dev1"));
        await PushAsync(client, spaceId, new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "space", spaceId, Fields(("name", "Private")), "000000100-0000-dev1"));
        // fetch one (t = 1_000s): two repayments, two identical dinners the same day; fetch two (t = 2_000s): the same again,
        // re-keyed; fetch three (t = 3_000s): the dinners once more PLUS a third dinner that is new
        const long one = 1_000_000, two = 2_000_000, three = 3_000_000;
        await PushAsync(client, feedId,
            FeedRow(feedId, "rep-sep-a", one, account, "2026-09-04", 163_756, "AFLOSSING", "ing-d-01"),
            FeedRow(feedId, "rep-oct-a", one + 1_000, account, "2026-10-04", 96_600, "AFLOSSING", "ing-d-02"),
            FeedRow(feedId, "din-a1", one + 2_000, account, "2026-10-04", 8_355, "NIELS", "ing-d-03"),
            FeedRow(feedId, "din-a2", one + 2_500, account, "2026-10-04", 8_355, "NIELS", "ing-d-04"),
            FeedRow(feedId, "rep-sep-b", two, account, "2026-09-04", 163_756, "AFLOSSING", "ing-d-05"),
            FeedRow(feedId, "rep-oct-b", two + 1_000, account, "2026-10-04", 96_600, "AFLOSSING", "ing-d-06"),
            FeedRow(feedId, "din-b1", two + 2_000, account, "2026-10-04", 8_355, "NIELS", "ing-d-07"),
            FeedRow(feedId, "din-b2", two + 2_500, account, "2026-10-04", 8_355, "NIELS", "ing-d-08"),
            FeedRow(feedId, "din-c1", three, account, "2026-10-04", 8_355, "NIELS", "ing-d-09"),
            FeedRow(feedId, "din-c2", three + 500, account, "2026-10-04", 8_355, "NIELS", "ing-d-10"),
            FeedRow(feedId, "din-c3", three + 1_000, account, "2026-10-04", 8_355, "NIELS", "ing-d-11"));
        // the space sees the account; the person paired the October repayment's COPY, and the original only carries the heal's one-way link
        await WithDbAsync(async db =>
        {
            db.SpaceAccountLinks.Add(new SpaceAccountLink { SpaceId = spaceId, FeedSpaceId = feedId, AccountId = account, HistoryFrom = "2026-01-01", Type = "checking" });
            await db.SaveChangesAsync();
            return 0;
        });
        await PushAsync(client, spaceId,
            Meta(spaceId, "rep-oct-a", "000000300-0000-dev1", ("txId", "rep-oct-a"), ("linkedAccountId", "acct-checking")),
            Meta(spaceId, "rep-oct-b", "000000301-0000-dev1", ("txId", "rep-oct-b"), ("linkedAccountId", "acct-checking"), ("transferPeerId", "chk-incasso")));

        var removed = await WithDbAsync(db => DerivedDuplicateRepair.RepairAsync(db, CancellationToken.None));

        var deleted = await WithDbAsync(async db => await db.EntityRows.Where(r => r.SpaceId == feedId && r.Entity == "transaction" && r.Deleted).Select(r => r.EntityId).ToListAsync());
        // September: the older copy stays; October: the PAIRED copy stays, the one-way original goes
        Assert.Contains("rep-sep-b", deleted);
        Assert.DoesNotContain("rep-sep-a", deleted);
        Assert.Contains("rep-oct-a", deleted);
        Assert.DoesNotContain("rep-oct-b", deleted);
        // the dinners: two real ones from fetch one, the third fetch brought one more - three stay, three go
        var dinners = new[] { "din-a1", "din-a2", "din-b1", "din-b2", "din-c1", "din-c2", "din-c3" };
        Assert.Equal(4, dinners.Count(deleted.Contains));
        Assert.DoesNotContain("din-a1", deleted);
        Assert.DoesNotContain("din-a2", deleted);
        Assert.Equal(6, removed);

        // the devices pull ordinary tombstones
        var pull = await client.GetFromJsonAsync<PullResponse>($"/sync/{feedId}/pull?since=0");
        Assert.Contains(pull!.Ops, o => o.EntityId == "rep-sep-b" && o.Deleted && o.OpId == ImportIds.OpId($"repair:derived-dup:{feedId}:rep-sep-b"));
        // idempotent
        Assert.Equal(0, await WithDbAsync(db => DerivedDuplicateRepair.RepairAsync(db, CancellationToken.None)));
    }

    [Fact]
    public void A_stamp_tells_its_wall_clock_and_a_blank_one_tells_nothing()
    {
        Assert.Equal(1_234_567L, DerivedDuplicateRepair.WallMs(ServerHlc.Encode(1_234_567, 3)));
        Assert.Equal(0L, DerivedDuplicateRepair.WallMs(null));
        Assert.Equal(0L, DerivedDuplicateRepair.WallMs("!!!-0000-dev1"));
    }
}
