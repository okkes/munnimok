using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BankConnector.Adapters.MockBank;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Accounts;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The relay's half of open banking as parties (plan §15, slice O2), walked
/// against the consent mock: a consent the relay keeps and the scheduler
/// fetches in the bank's own hour, the party's budget on the operator's
/// status document, the pending mirror and the prediction overlay, the
/// lookup and inventory routes relayed, and a feed's deletion reaching the
/// party.
/// </summary>
public class ConnectorOpenBankingTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Consent = MockBankConsentAdapter.ProviderId;
    private const string Admin = "openid profile admin";
    private const string ReturnUrl = "https://app.test/gc-callback";

    [Fact]
    public async Task A_consent_is_kept_by_the_relay_and_the_scheduler_fetches_it_without_a_device_in_the_banks_hour()
    {
        const string sub = "consent-keeper";
        var (sessionId, userId) = await ConnectAsync(sub, "conn-consent");
        var row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.NotNull(row.KeptBundle);   // server custody: the consent id and the accounts, never a secret
        Assert.Equal("active", row.State);

        var service = factory.Services.GetRequiredService<ConnectorScheduleService>();
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));   // a session that never ran is due at once
        row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.Null(row.LastScheduleError);
        Assert.NotNull(row.LastScheduledSyncAt);
        var feedId = ImportIds.FeedSpaceId(MockBankLedger.CurrentIban);
        Assert.True(factory.Read(db => db.EntityRows.Count(r => r.SpaceId == feedId && r.Entity == "transaction")) > 0);
        var reference = factory.Read(db => db.ConnectorAccountRefs.First(a => a.UserId == userId && a.AccountRef == ImportIds.Normalize(MockBankLedger.CurrentIban)));
        Assert.Equal("conn-consent", reference.ConnectionId);

        // the party said something about its budget: the operator sees it on the status document
        using var operatorClient = factory.ClientFor("the-quota-operator", scope: Admin);
        var status = await operatorClient.GetFromJsonAsync<JsonObject>("/admin/connectors/status");
        var party = status!["providers"]!.AsArray().OfType<JsonObject>().Single(p => p["providerId"]!.GetValue<string>() == Consent);
        Assert.Equal(4, party["quota"]!["limit"]!.GetValue<int>());
        Assert.Equal(3, party["quota"]!["remaining"]!.GetValue<int>());

        // within the party's interval nothing runs again
        Assert.Equal(0, await service.RunOnceAsync(CancellationToken.None));

        // past the interval, only in the bank's preferred hour, in the bank's zone; a retry-after stands in the way
        using var scope = factory.Services.CreateScope();
        var relay = scope.ServiceProvider.GetRequiredService<ConnectorRelay>();
        var manifest = await relay.Catalogue.ProviderAsync(relay.Client, Consent, CancellationToken.None);
        Assert.NotNull(manifest);
        var clock = new ConnectorUnitTests.TestClock(new DateTimeOffset(2026, 9, 30, 1, 0, 0, TimeSpan.Zero));   // 03:00 in Amsterdam
        var timed = new ConnectorScheduleService(factory.Services.GetRequiredService<IServiceScopeFactory>(), clock, NullLogger<ConnectorScheduleService>.Instance);
        var probe = new ConnectorSession { Id = "ses_probe", Provider = Consent, ConnectionId = "c", State = "active", LastScheduledSyncAt = clock.GetUtcNow().AddHours(-21) };
        var amsterdam = BankZones.ZoneFor(MockBankLedger.CurrentIban);
        Assert.True(timed.IsDue(probe, manifest, amsterdam));
        clock.Advance(TimeSpan.FromHours(2));                                   // 05:00 local: not the hour
        Assert.False(timed.IsDue(probe, manifest, amsterdam));
        clock.Advance(TimeSpan.FromHours(22));                                  // 03:00 local, the next day
        Assert.True(timed.IsDue(probe, manifest, amsterdam));
        probe.ScheduleNotBefore = clock.GetUtcNow().AddHours(1);
        Assert.False(timed.IsDue(probe, manifest, amsterdam));
        Assert.Equal(amsterdam, await ConnectorScheduleService.ZoneOfAsync(relay.Db, row, manifest, CancellationToken.None));

        // the party's budget: rate_limited sets the not-before from its retry-after, or the day's stand-down; an ended consent asks the person
        timed.Refused(probe, "rate_limited", 1800);
        Assert.Equal(clock.GetUtcNow().AddSeconds(1800), probe.ScheduleNotBefore);
        Assert.Equal("active", probe.State);
        timed.Refused(probe, "rate_limited", null);
        Assert.Equal(clock.GetUtcNow() + ConnectorScheduleService.RateLimitStandDown, probe.ScheduleNotBefore);
        timed.Refused(probe, "consent_expired", null);
        Assert.Equal("needs_reauth", probe.State);
        Assert.Null(probe.KeptBundle);
    }

    [Fact]
    public async Task The_overlay_fills_only_what_nobody_said_a_device_s_category_outranks_it_before_and_after()
    {
        const string sub = "overlay-floor";
        using var client = factory.ClientFor(sub);
        Assert.True((await client.GetAsync("/connectors")).IsSuccessStatusCode);
        var userId = factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
        const string iban = "NL91MOCK0000000778";
        using var scope = factory.Services.CreateScope();
        var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();
        var ct = CancellationToken.None;
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-floor", "account",
            [new JsonObject { ["id"] = "acc_floor", ["external_id"] = iban, ["iban"] = iban, ["display_name"] = "Betaal", ["currency"] = "EUR", ["type"] = "current" }], ct);
        var reference = factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_floor"));
        var spaceId = $"space_{Guid.NewGuid():N}";
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "space", spaceId, new Dictionary<string, JsonElement> { ["name"] = JsonSerializer.SerializeToElement("Floor") }, ServerHlc.Now(0))]));
        Assert.True((await client.PostAsJsonAsync($"/spaces/{spaceId}/accounts", new AttachAccountRequest(reference.FeedSpaceId, reference.AccountEntityId, "2026-01-01"))).IsSuccessStatusCode);

        // the person filed the row BEFORE the party's facts landed (a device that
        // attached the account itself, or the 2026-10-05 re-overlay of a whole history)
        var bookedId = ImportIds.TransactionId(ImportIds.Normalize(iban), "REF-F1");
        var metaId = ImportIds.TxMetaId(spaceId, bookedId);
        var filed = new Dictionary<string, JsonElement> { ["txId"] = JsonSerializer.SerializeToElement(bookedId), ["catId"] = JsonSerializer.SerializeToElement("tuition"), ["needsReview"] = JsonSerializer.SerializeToElement(0) };
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "txMeta", metaId, filed, "000000200-0000-dev1")]));
        var tx = Tx("txn_f1", "REF-F1", "2026-09-28", -1250, "Albert Heijn", "Albert Heijn 1350 AMSTERDAM");
        tx["account_id"] = "acc_floor";
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-floor", "transaction", [tx], ct);
        var meta = factory.Read(db => db.EntityRows.Single(r => r.SpaceId == spaceId && r.Entity == "txMeta" && r.EntityId == metaId));
        Assert.Contains("\"catId\":\"tuition\"", meta.DataJson);   // the overlay filled nothing the person had said
        Assert.Contains("\"needsReview\":0", meta.DataJson);
        Assert.Contains("\"txType\":\"expense\"", meta.DataJson);   // ...and only what nobody had
        Assert.Contains($"\"txType\":\"{ServerHlc.Floor}\"", meta.FieldVersionsJson);

        // a row the party filed first: the prediction stands until a device speaks, and any device stamp wins
        var later = Tx("txn_f2", "REF-F2", "2026-09-29", -300, "NS", "NS Reizigers");
        later["account_id"] = "acc_floor";
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-floor", "transaction", [later], ct);
        var laterMetaId = ImportIds.TxMetaId(spaceId, ImportIds.TransactionId(ImportIds.Normalize(iban), "REF-F2"));
        Assert.Contains($"\"catId\":\"{ServerHlc.Floor}\"", factory.Read(db => db.EntityRows.Single(r => r.SpaceId == spaceId && r.EntityId == laterMetaId).FieldVersionsJson));
        var chosen = new Dictionary<string, JsonElement> { ["catId"] = JsonSerializer.SerializeToElement("transport"), ["needsReview"] = JsonSerializer.SerializeToElement(0) };
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "txMeta", laterMetaId, chosen, "000000001-0000-dev1")]));
        Assert.Contains("\"catId\":\"transport\"", factory.Read(db => db.EntityRows.Single(r => r.SpaceId == spaceId && r.EntityId == laterMetaId).DataJson));
    }

    [Fact]
    public async Task An_open_banking_feed_is_never_taken_over_by_a_lesser_party_feeding_the_same_account()
    {
        const string sub = "feed-rank";
        using var client = factory.ClientFor(sub);
        Assert.True((await client.GetAsync("/connectors")).IsSuccessStatusCode);
        var userId = factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
        const string iban = "NL91MOCK0000000779";
        using var scope = factory.Services.CreateScope();
        var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();
        var ct = CancellationToken.None;
        JsonObject Account(string id, long balance) => new() { ["id"] = id, ["external_id"] = iban, ["iban"] = iban, ["display_name"] = "Betaal", ["currency"] = "EUR", ["type"] = "current", ["balance"] = new JsonObject { ["amount"] = new JsonObject { ["value"] = balance, ["currency"] = "EUR" } } };
        string Row() => factory.Read(db => db.EntityRows.Single(r => r.Entity == "account" && r.EntityId == db.ConnectorAccountRefs.Single(a => a.Id == "acc_rank_eb").AccountEntityId && r.SpaceId == db.ConnectorAccountRefs.Single(a => a.Id == "acc_rank_eb").FeedSpaceId).DataJson);

        // Enable Banking feeds the account first
        await ingest.IngestAsync(userId, "enablebanking", "Enable Banking", "conn-eb", "account", [Account("acc_rank_eb", 10_000)], ct);
        Assert.Contains("\"provider\":\"enablebanking\"", Row());
        Assert.Contains("\"connectionId\":\"conn-eb\"", Row());

        // the bank's own login reaches the same IBAN: its balance lands, the account stays Enable Banking's
        await ingest.IngestAsync(userId, "ing-nl", "ING", "conn-ing", "account", [Account("acc_rank_ing", 12_000)], ct);
        var afterIng = Row();
        Assert.Contains("\"balanceCents\":12000", afterIng);
        Assert.Contains("\"provider\":\"enablebanking\"", afterIng);
        Assert.Contains("\"connectionId\":\"conn-eb\"", afterIng);
        Assert.DoesNotContain("conn-ing", afterIng);

        // another open-banking consent takes the stamps over (equal rank), the bank login still cannot
        await ingest.IngestAsync(userId, "gocardless", "GoCardless", "conn-gc", "account", [Account("acc_rank_gc", 12_500)], ct);
        Assert.Contains("\"connectionId\":\"conn-gc\"", Row());
        await ingest.IngestAsync(userId, "ing-nl", "ING", "conn-ing", "account", [Account("acc_rank_ing", 13_000)], ct);
        Assert.Contains("\"connectionId\":\"conn-gc\"", Row());
        Assert.Contains("\"provider\":\"gocardless\"", Row());

        // a bank login that feeds an account nobody else does owns it as before
        const string own = "NL91MOCK0000000780";
        await ingest.IngestAsync(userId, "ing-nl", "ING", "conn-ing", "account", [new JsonObject { ["id"] = "acc_rank_solo", ["external_id"] = own, ["iban"] = own, ["display_name"] = "Spaar", ["currency"] = "EUR", ["type"] = "savings" }], ct);
        var solo = factory.Read(db => db.EntityRows.Single(r => r.Entity == "account" && r.EntityId == db.ConnectorAccountRefs.Single(a => a.Id == "acc_rank_solo").AccountEntityId).DataJson);
        Assert.Contains("\"provider\":\"ing-nl\"", solo);
        Assert.Contains("\"connectionId\":\"conn-ing\"", solo);
    }

    [Fact]
    public async Task The_pending_mirror_follows_the_bank_and_the_overlay_predicts_where_the_account_is_attached()
    {
        const string sub = "pending-mirror";
        using var client = factory.ClientFor(sub);
        Assert.True((await client.GetAsync("/connectors")).IsSuccessStatusCode);   // provisions the user
        var userId = factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
        const string iban = "NL91MOCK0000000777";
        using var scope = factory.Services.CreateScope();
        var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();
        var ct = CancellationToken.None;

        var accounts = await ingest.IngestAsync(userId, Consent, "Mock", "conn-mirror", "account",
            [new JsonObject { ["id"] = "acc_mirror", ["external_id"] = iban, ["iban"] = iban, ["display_name"] = "Betaal", ["currency"] = "EUR", ["type"] = "current", ["institution"] = "MOCK_NL" }], ct);
        Assert.Equal(1, accounts.Counts.Accounts);
        var reference = factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_mirror"));
        Assert.Equal("conn-mirror", reference.ConnectionId);
        // the institution the lookup listed rides the account row, so the app shows the same logo
        Assert.Contains("\"bankId\":\"MOCK_NL\"", factory.Read(db => db.EntityRows.Single(r => r.SpaceId == reference.FeedSpaceId && r.EntityId == reference.AccountEntityId).DataJson));

        // the account attached to a space: where the overlay goes
        var spaceId = $"space_{Guid.NewGuid():N}";
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "space", spaceId, new Dictionary<string, JsonElement> { ["name"] = JsonSerializer.SerializeToElement("Mirror") }, ServerHlc.Now(0))]));
        var attached = await client.PostAsJsonAsync($"/spaces/{spaceId}/accounts", new AttachAccountRequest(reference.FeedSpaceId, reference.AccountEntityId, "2026-01-01"));
        Assert.True(attached.IsSuccessStatusCode, await attached.Content.ReadAsStringAsync());

        var landed = await ingest.IngestAsync(userId, Consent, "Mock", "conn-mirror", "transaction",
            [Tx("txn_1", "REF-1", "2026-09-28", -1250, "Albert Heijn", "Albert Heijn 1350 AMSTERDAM"), Tx("txn_2", "pending:P-1", "2026-09-30", -300, "NS", "NS Reizigers")], ct);
        Assert.Equal(2, landed.Counts.Transactions);
        var pendingRow = Assert.Single(landed.PendingRows);
        Assert.Equal("acc_mirror", pendingRow.AccountRefId);
        Assert.Contains(spaceId, landed.Attached);
        var pendingId = ImportIds.TransactionId(ImportIds.Normalize(iban), "pending:P-1");
        Assert.Contains("\"pending\":1", factory.Read(db => db.EntityRows.Single(r => r.SpaceId == reference.FeedSpaceId && r.EntityId == pendingId).DataJson));
        var bookedId = ImportIds.TransactionId(ImportIds.Normalize(iban), "REF-1");
        var meta = factory.Read(db => db.EntityRows.Single(r => r.SpaceId == spaceId && r.Entity == "txMeta" && r.EntityId == ImportIds.TxMetaId(spaceId, bookedId)));
        Assert.Contains("\"needsReview\":0", meta.DataJson);   // the keyword rules know Albert Heijn
        Assert.DoesNotContain("uncategorized", meta.DataJson);
        Assert.Empty(factory.Read(db => db.EntityRows.Where(r => r.SpaceId == spaceId && r.Entity == "txMeta" && r.EntityId == ImportIds.TxMetaId(spaceId, pendingId)).ToList()));

        // the same pending row again: nothing to tombstone, and it is remembered
        Assert.Equal(0, await ingest.SettlePendingAsync(userId, Consent, "conn-mirror", landed.PendingRows, ct));
        Assert.Equal(1, factory.Read(db => db.ConnectorPendingTxs.Count(p => p.AccountRefId == "acc_mirror")));
        // the bank stopped reporting it: tombstoned and forgotten
        Assert.Equal(1, await ingest.SettlePendingAsync(userId, Consent, "conn-mirror", [], ct));
        Assert.True(factory.Read(db => db.EntityRows.Single(r => r.SpaceId == reference.FeedSpaceId && r.EntityId == pendingId).Deleted));
        Assert.Equal(0, factory.Read(db => db.ConnectorPendingTxs.Count(p => p.AccountRefId == "acc_mirror")));
    }

    [Fact]
    public async Task The_relay_lists_a_partys_options_vendors_a_logo_and_the_operator_reads_the_inventory()
    {
        using var client = factory.ClientFor("lookup-user");
        var options = await client.GetFromJsonAsync<JsonObject>($"/connectors/{Consent}/options/institution?q=mock&country=NL");
        var first = options!["options"]!.AsArray().OfType<JsonObject>().First();
        Assert.Equal(MockBankConsentAdapter.Institution, first["value"]!.GetValue<string>());
        Assert.True(first["hasLogo"]!.GetValue<bool>());

        using var logo = await client.GetAsync($"/connectors/{Consent}/options/institution/{Token(MockBankConsentAdapter.Institution)}/logo");
        Assert.Equal(HttpStatusCode.OK, logo.StatusCode);
        Assert.Equal("image/png", logo.Content.Headers.ContentType?.MediaType);
        Assert.Contains("immutable", logo.Headers.CacheControl?.ToString());
        using var none = await client.GetAsync($"/connectors/{Consent}/options/institution/{Token("mock-institution-plain")}/logo");
        Assert.Equal(HttpStatusCode.NotFound, none.StatusCode);
        using var unsupported = await client.GetAsync("/connectors/mock-store-simple/options/institution");
        Assert.Equal(HttpStatusCode.BadRequest, unsupported.StatusCode);   // the connector's own refusal, relayed

        using var operatorClient = factory.ClientFor("the-inventory-operator", scope: Admin);
        var consents = await operatorClient.GetFromJsonAsync<JsonObject>($"/admin/connectors/providers/{Consent}/remote-consents");
        var list = consents!["consents"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Contains(list, c => c["origin"]!.GetValue<string>() == "https://other.mock.invalid" && c["reference"]!.GetValue<string>() == "legacy");
        using var revoked = await operatorClient.DeleteAsync($"/admin/connectors/providers/{Consent}/remote-consents/mock-consent-elsewhere");
        Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        var after = await operatorClient.GetFromJsonAsync<JsonObject>($"/admin/connectors/providers/{Consent}/remote-consents");
        Assert.DoesNotContain(after!["consents"]!.AsArray().OfType<JsonObject>(), c => c["id"]!.GetValue<string>() == "mock-consent-elsewhere");
        using var plain = factory.ClientFor("plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await plain.GetAsync($"/admin/connectors/providers/{Consent}/remote-consents")).StatusCode);
    }

    [Fact]
    public async Task Deleting_a_feed_takes_its_account_out_of_the_consent_and_the_last_one_ends_it_at_the_party()
    {
        const string sub = "consent-leaver";
        var (sessionId, userId) = await ConnectAsync(sub, "conn-leaving");
        var service = factory.Services.GetRequiredService<ConnectorScheduleService>();
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));
        var refs = factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == userId).ToList());
        Assert.True(refs.Count > 1, "the mock consent reaches several accounts");
        using var client = factory.ClientFor(sub);

        // one feed of several: the account leaves the consent, the consent lives on for the rest
        var currentFeed = ImportIds.FeedSpaceId(MockBankLedger.CurrentIban);
        using (var deleted = await client.DeleteAsync($"/me/feeds/{currentFeed}"))
        {
            Assert.True(deleted.IsSuccessStatusCode, await deleted.Content.ReadAsStringAsync());
        }
        Assert.True(factory.Read(db => db.ConnectorAccountRefs.Single(a => a.UserId == userId && a.FeedSpaceId == currentFeed).Excluded));
        Assert.Single(factory.Read(db => db.ConnectorSessions.Where(s => s.Id == sessionId).ToList()));
        await PatchAsync(sessionId, s => s.LastScheduledSyncAt = null);
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));
        Assert.True(factory.Read(db => db.ConnectorAccountRefs.Single(a => a.UserId == userId && a.FeedSpaceId == currentFeed).Excluded), "a fetch does not invent the dropped account back");

        // the rest of them: the consent ends at the party and the binding is forgotten
        foreach (var feed in factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == userId && !a.Excluded).Select(a => a.FeedSpaceId).Distinct().ToList()))
        {
            using var deleted = await client.DeleteAsync($"/me/feeds/{feed}");
            Assert.True(deleted.IsSuccessStatusCode, await deleted.Content.ReadAsStringAsync());
        }
        var remaining = factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == userId)
            .Select(a => $"{a.Id} conn={a.ConnectionId} excluded={a.Excluded} feed={a.FeedSpaceId}").ToList());
        Assert.True(factory.Read(db => db.ConnectorSessions.Count(s => s.Id == sessionId)) == 0, $"the session survived; refs: {string.Join(" | ", remaining)}");
        Assert.Empty(remaining);
        using var gone = await client.GetAsync($"/connectors/{Consent}/login/{sessionId}");
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /// <summary>A login through the relay: the redirect challenge, answered with the bank's return, settles to an active consent.</summary>
    private async Task<(string SessionId, Guid UserId)> ConnectAsync(string sub, string connectionId)
    {
        using var client = factory.ClientFor(sub);
        using var response = await client.PostAsJsonAsync($"/connectors/{Consent}/login", new
        {
            connectionId,
            inputs = new Dictionary<string, string> { ["country"] = "NL", ["institution"] = MockBankConsentAdapter.Institution },
            config = new Dictionary<string, string> { ["return_url"] = ReturnUrl },
        });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, view!.ToJsonString());
        var sessionId = view["sessionId"]!.GetValue<string>();

        var awaiting = await AwaitStateAsync(client, sessionId, "awaiting_input");
        var challenge = Assert.IsType<JsonObject>(awaiting["challenge"]);
        Assert.Equal("redirect", challenge["type"]!.GetValue<string>());
        Assert.Equal(ReturnUrl + "*", challenge["returnPattern"]!.GetValue<string>());
        var code = challenge["code"]!.GetValue<string>();
        using var answered = await client.PostAsJsonAsync($"/connectors/{Consent}/login/{sessionId}/answer",
            new { challengeId = challenge["id"]!.GetValue<string>(), value = $"{ReturnUrl}?ref={code}" });
        Assert.True(answered.IsSuccessStatusCode, await answered.Content.ReadAsStringAsync());
        await AwaitStateAsync(client, sessionId, "active");
        return (sessionId, factory.Read(db => db.Users.Single(u => u.Sub == sub).Id));
    }

    private static async Task<JsonObject> AwaitStateAsync(HttpClient client, string sessionId, string state)
    {
        JsonObject? last = null;
        for (var i = 0; i < 150; i++)
        {
            last = await client.GetFromJsonAsync<JsonObject>($"/connectors/{Consent}/login/{sessionId}");
            if (last!["state"]?.GetValue<string>() == state) return last;
            await Task.Delay(100);
        }
        Assert.Fail($"session never reached '{state}': {last?.ToJsonString()}");
        throw new UnreachableException();
    }

    private async Task PatchAsync(string sessionId, Action<ConnectorSession> patch)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.SingleAsync(db.ConnectorSessions, s => s.Id == sessionId);
        patch(row);
        await db.SaveChangesAsync();
    }

    private static JsonObject Tx(string id, string externalId, string bookedAt, long cents, string counterparty, string description) => new()
    {
        ["id"] = id,
        ["external_id"] = externalId,
        ["account_id"] = "acc_mirror",
        ["booked_at"] = bookedAt,
        ["amount"] = new JsonObject { ["value"] = cents, ["currency"] = "EUR" },
        ["counterparty"] = new JsonObject { ["name"] = counterparty },
        ["description"] = description,
    };

    private static string Token(string value) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
