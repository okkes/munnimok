using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Accounts;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The relay against the real control plane (docs/connector-integration-plan.md
/// §5, M1): subjects minted here, sessions bound to their user, bundles passing
/// through and never resting, the catalogue in the app's casing, the sync
/// landing records in the feeds. The mock providers are the ones the
/// shipped catalogue carries.
/// </summary>
public class ConnectorRelayTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string MockStore = "mock-store-simple";
    private const string MockBank = "mock-bank-simple";
    private const string MockRegistry = "mock-registry-simple";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    /// <summary>D9: a registry position is one of the liability types the app knows.</summary>
    private static readonly string[] LiabilityTypes = ["loan", "credit", "mortgage"];

    [Fact]
    public async Task Health_says_the_environment_runs_connectors()
    {
        using var client = factory.CreateClient();
        var health = await client.GetFromJsonAsync<JsonObject>("/health");
        Assert.True(health!["capabilities"]!["connectors"]!.GetValue<bool>());
    }

    [Fact]
    public async Task The_relay_needs_a_signed_in_user()
    {
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/connectors/providers")).StatusCode);
    }

    [Fact]
    public async Task The_catalogue_arrives_in_the_apps_casing_and_revalidates()
    {
        using var client = factory.ClientFor("catalogue-reader");

        using var first = await client.GetAsync("/connectors/providers");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var etag = first.Headers.ETag?.ToString();
        Assert.False(string.IsNullOrEmpty(etag));

        var catalogue = await first.Content.ReadFromJsonAsync<JsonObject>();
        var providers = catalogue!["providers"]!.AsArray();
        var store = providers.Single(p => p!["id"]!.GetValue<string>() == MockStore)!.AsObject();
        Assert.Equal("store", store["kind"]!.GetValue<string>());
        Assert.NotNull(store["manifestVersion"]);
        Assert.NotNull(store["auth"]!["flow"]);
        Assert.Contains(providers, p => p!["kind"]!.GetValue<string>() == "bank");
        Assert.Contains(providers, p => p!["kind"]!.GetValue<string>() == "registry");
        // nothing from the connector's casing leaks
        Assert.DoesNotContain("manifest_version", catalogue.ToJsonString(), StringComparison.Ordinal);
        Assert.Contains("kinds", catalogue["service"]!.ToJsonString(), StringComparison.Ordinal);

        using var again = new HttpRequestMessage(HttpMethod.Get, "/connectors/providers");
        again.Headers.TryAddWithoutValidation("If-None-Match", etag);
        using var second = await client.SendAsync(again);
        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);

        var overview = await client.GetFromJsonAsync<JsonObject>("/connectors");
        Assert.True(overview!["householdAgents"]!.GetValue<bool>());
        Assert.True(overview["providers"]!.GetValue<int>() >= 3);
    }

    [Fact]
    public async Task A_login_binds_the_session_to_its_user_and_hands_the_bundle_through()
    {
        using var client = factory.ClientFor("login-owner");

        var (status, view) = await LoginAsync(client, MockStore, "conn-1");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("active", view["state"]!.GetValue<string>());
        var sessionId = view["sessionId"]!.GetValue<string>();
        var bundle = view["bundle"]!.GetValue<string>();
        Assert.StartsWith("sb_v1.", bundle, StringComparison.Ordinal);
        Assert.Equal("Shop of mine", view["label"]!.GetValue<string>());
        // the app's casing throughout
        Assert.NotNull(view["providerAccount"]!["displayName"]);
        Assert.Null(view["session_id"]);

        // bound: ids and state, never the bundle
        var row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.Equal("conn-1", row.ConnectionId);
        Assert.Equal(MockStore, row.Provider);
        Assert.Equal("active", row.State);
        Assert.Equal("Shop of mine", row.Label);
        AssertNothingStoredResembles(bundle);

        // the owner's list and view
        var mine = await client.GetFromJsonAsync<JsonArray>("/connectors/sessions");
        Assert.Contains(mine!, s => s!["sessionId"]!.GetValue<string>() == sessionId);
        using var read = await client.GetAsync($"/connectors/{MockStore}/login/{sessionId}");
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);

        // a re-login of the same connection replaces the row
        var (_, second) = await LoginAsync(client, MockStore, "conn-1");
        var secondId = second["sessionId"]!.GetValue<string>();
        Assert.NotEqual(sessionId, secondId);
        var rows = factory.Read(db => db.ConnectorSessions.Where(s => s.ConnectionId == "conn-1").Select(s => s.Id).ToList());
        Assert.Equal([secondId], rows);
    }

    [Fact]
    public async Task Somebody_elses_session_is_unknown_and_so_is_a_made_up_one()
    {
        using var owner = factory.ClientFor("session-owner");
        using var stranger = factory.ClientFor("session-stranger");
        var (_, view) = await LoginAsync(owner, MockStore, "conn-owned");
        var sessionId = view["sessionId"]!.GetValue<string>();

        foreach (var path in new[]
                 {
                     $"/connectors/{MockStore}/login/{sessionId}",
                     $"/connectors/{MockStore}/login/{sessionId}/challenges/chl_x/image",
                     $"/connectors/{MockStore}/login/{sessionId}/challenges/chl_x/live/frame?after=0",
                 })
        {
            using var response = await stranger.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            var error = (await response.Content.ReadFromJsonAsync<JsonObject>())!["error"]!;
            Assert.Equal("unsupported_resource", error["code"]!.GetValue<string>());
            Assert.Equal("connect.error.unsupported_resource", error["messageKey"]!.GetValue<string>());
        }

        using var answer = await stranger.PostAsJsonAsync($"/connectors/{MockStore}/login/{sessionId}/answer", new { challengeId = "chl_x", value = "1" });
        Assert.Equal(HttpStatusCode.NotFound, answer.StatusCode);
        using var cancel = await stranger.PostAsync($"/connectors/{MockStore}/login/{sessionId}/cancel", null);
        Assert.Equal(HttpStatusCode.NotFound, cancel.StatusCode);
        using var madeUp = await owner.GetAsync($"/connectors/{MockStore}/login/ses_00000000000000000000000000");
        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
    }

    [Fact]
    public async Task A_sync_lands_the_receipts_in_the_store_feed_and_returns_no_bundle_it_did_not_rotate()
    {
        const string sub = "receipt-syncer";
        using var client = factory.ClientFor(sub);
        var (_, view) = await LoginAsync(client, MockStore, "conn-receipts");
        var bundle = view["bundle"]!.GetValue<string>();

        var body = await SyncToTheEndAsync(client, MockStore, "conn-receipts", bundle, "2026-06-01");
        var ingested = body["ingested"]!;
        Assert.True(ingested["receipts"]!.GetValue<int>() > 0, body.ToJsonString());
        Assert.Equal(ingested["receipts"]!.GetValue<int>(), ingested["records"]!.GetValue<int>());
        Assert.Equal(0, ingested["dropped"]!.GetValue<int>());
        // a provider that does not rotate re-issues nothing
        Assert.Null(body["session"]);

        var feedId = ImportIds.PersonalFeedSpaceId(ConnectorIngest.StoreFeedRef, sub);
        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var feed = factory.Read(db => db.FeedSpaces.Single(f => f.Id == feedId));
        Assert.Equal(user.Id, feed.OwnerUserId);
        Assert.True(factory.Read(db => db.SpaceMembers.Any(m => m.SpaceId == feedId && m.UserId == user.Id)));

        var receipts = factory.Read(db => db.EntityRows.Where(r => r.SpaceId == feedId && r.Entity == "receipt").ToList());
        Assert.Equal(ingested["receipts"]!.GetValue<int>(), receipts.Count);
        var first = JsonDocument.Parse(receipts[0].DataJson).RootElement;
        Assert.StartsWith($"rcpt:{MockStore}:conn-receipts:", receipts[0].EntityId, StringComparison.Ordinal);
        Assert.Equal(MockStore, first.GetProperty("source").GetString());
        Assert.Equal("conn-receipts", first.GetProperty("instanceId").GetString());
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}$", first.GetProperty("date").GetString());
        Assert.NotEqual(0, first.GetProperty("totalCents").GetInt64());
        Assert.StartsWith($"{MockStore}:", first.GetProperty("storeRef").GetString(), StringComparison.Ordinal);
        Assert.True(first.GetProperty("items").GetArrayLength() > 0);
        AssertNothingStoredResembles(bundle);

        // the same sync again is a no-op: every op id is deterministic
        var repeat = await SyncToTheEndAsync(client, MockStore, "conn-receipts", bundle, "2026-06-01");
        Assert.Equal(0, repeat["ingested"]!["receipts"]!.GetValue<int>());
        Assert.Equal(receipts.Count, factory.Read(db => db.EntityRows.Count(r => r.SpaceId == feedId && r.Entity == "receipt")));
    }

    [Fact]
    public async Task A_bank_sync_lands_accounts_in_their_feeds_and_the_transactions_behind_them()
    {
        const string sub = "bank-syncer";
        using var client = factory.ClientFor(sub);
        var (status, view) = await LoginAsync(client, MockBank, "conn-bank");
        Assert.Equal(HttpStatusCode.OK, status);
        var bundle = view["bundle"]!.GetValue<string>();

        var body = await SyncToTheEndAsync(client, MockBank, "conn-bank", bundle);
        var ingested = body["ingested"]!;
        Assert.True(ingested["accounts"]!.GetValue<int>() > 0, body.ToJsonString());
        Assert.True(ingested["transactions"]!.GetValue<int>() > 0, body.ToJsonString());
        Assert.Equal(0, ingested["dropped"]!.GetValue<int>());

        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var refs = factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == user.Id).ToList());
        Assert.Equal(ingested["accounts"]!.GetValue<int>(), refs.Count);
        foreach (var reference in refs)
        {
            var account = factory.Read(db => db.EntityRows.Single(r => r.SpaceId == reference.FeedSpaceId && r.Entity == "account" && r.EntityId == reference.AccountEntityId));
            var data = JsonDocument.Parse(account.DataJson).RootElement;
            Assert.Equal(ConnectorIngest.Source, data.GetProperty("source").GetString());
            Assert.Equal(MockBank, data.GetProperty("provider").GetString());
            Assert.True(data.TryGetProperty("name", out _));
            Assert.True(data.TryGetProperty("type", out _));
            Assert.True(data.TryGetProperty("lastSyncedAt", out _));
            var isIban = !reference.AccountRef.StartsWith("CONN:", StringComparison.Ordinal);
            Assert.Equal(isIban ? ImportIds.FeedSpaceId(reference.AccountRef) : ImportIds.PersonalFeedSpaceId(reference.AccountRef, sub), reference.FeedSpaceId);
            if (isIban) Assert.Equal(reference.AccountRef, data.GetProperty("iban").GetString());
            Assert.True(factory.Read(db => db.FeedSpaces.Any(f => f.Id == reference.FeedSpaceId && f.OwnerUserId == user.Id)));
        }

        var transactions = factory.Read(db => db.EntityRows.Where(r => refs.Select(a => a.FeedSpaceId).Contains(r.SpaceId) && r.Entity == "transaction").ToList());
        Assert.Equal(ingested["transactions"]!.GetValue<int>(), transactions.Count);
        var tx = JsonDocument.Parse(transactions[0].DataJson).RootElement;
        Assert.Contains(refs, a => a.AccountEntityId == tx.GetProperty("accountId").GetString());
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}$", tx.GetProperty("date").GetString());
        Assert.True(tx.TryGetProperty("amountCents", out _));
        Assert.True(tx.TryGetProperty("importRef", out _));
        AssertNothingStoredResembles(bundle);
    }

    [Fact]
    public async Task A_registry_sync_lands_liability_accounts_in_the_registry_feed()
    {
        const string sub = "registry-syncer";
        using var client = factory.ClientFor(sub);
        var (status, view) = await LoginAsync(client, MockRegistry, "conn-registry");
        Assert.Equal(HttpStatusCode.OK, status);
        var bundle = view["bundle"]!.GetValue<string>();

        var body = await SyncToTheEndAsync(client, MockRegistry, "conn-registry", bundle);
        Assert.True(body["ingested"]!["positions"]!.GetValue<int>() > 0, body.ToJsonString());

        var feedId = ImportIds.PersonalFeedSpaceId(ConnectorIngest.RegistryFeedRef, sub);
        var positions = factory.Read(db => db.EntityRows.Where(r => r.SpaceId == feedId && r.Entity == "account").ToList());
        Assert.Equal(body["ingested"]!["positions"]!.GetValue<int>(), positions.Count);
        foreach (var position in positions)
        {
            var data = JsonDocument.Parse(position.DataJson).RootElement;
            Assert.StartsWith($"acct:{MockRegistry}:", position.EntityId, StringComparison.Ordinal);
            Assert.Equal(ConnectorIngest.Source, data.GetProperty("source").GetString());
            Assert.Contains(data.GetProperty("type").GetString(), LiabilityTypes);
            Assert.True(data.GetProperty("originalCents").GetInt64() > 0);
            Assert.True(data.TryGetProperty("note", out _));
        }
    }

    [Fact]
    public async Task A_disconnect_removes_the_binding_and_a_stranger_cannot()
    {
        using var owner = factory.ClientFor("disconnect-owner");
        using var stranger = factory.ClientFor("disconnect-stranger");
        var (_, view) = await LoginAsync(owner, MockStore, "conn-bye");
        var sessionId = view["sessionId"]!.GetValue<string>();

        using var refused = await stranger.DeleteAsync($"/connectors/{MockStore}/sessions/{sessionId}");
        Assert.NotEqual(HttpStatusCode.OK, refused.StatusCode);
        Assert.True(factory.Read(db => db.ConnectorSessions.Any(s => s.Id == sessionId)));

        using var request = new HttpRequestMessage(HttpMethod.Delete, $"/connectors/{MockStore}/sessions/{sessionId}")
        {
            Content = JsonContent.Create(new { bundle = view["bundle"]!.GetValue<string>() }),
        };
        using var response = await owner.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var outcome = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.NotNull(outcome!["loggedOut"]);
        Assert.False(factory.Read(db => db.ConnectorSessions.Any(s => s.Id == sessionId)));

        // and the connector no longer serves it either
        using var gone = await owner.GetAsync($"/connectors/{MockStore}/login/{sessionId}");
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    [Fact]
    public async Task The_binding_tables_hold_ids_and_state_only()
    {
        // the write-path scan: nothing the relay persists has a field a bundle,
        // an input or a credential could ride in — with the one documented
        // exception: the household-agent pointer §5.5 lets the relay keep,
        // which the client-custody flows above prove stays empty
        var entities = factory.Read(db => db.Model.GetEntityTypes()
            .Where(e => e.ClrType.Namespace == typeof(ConnectorSession).Namespace)
            .Select(e => e.ClrType)
            .ToList());
        Assert.Equal(3, entities.Count);   // sessions, account references, the pending mirror (§15)
        foreach (var property in entities.SelectMany(e => e.GetProperties()).Where(p => p.Name != nameof(ConnectorSession.KeptBundle)))
        {
            Assert.DoesNotMatch("(?i)bundle|input|credential|secret|token|password", property.Name);
        }
        Assert.Equal(
            ["ConnectionId", "CreatedAt", "Id", "KeptBundle", "Label", "LastScheduledSyncAt", "LastScheduleError", "LastSeenAt", "Provider", "ScheduleNotBefore", "State", "UserId"],
            typeof(ConnectorSession).GetProperties().Select(p => p.Name).Order().ToArray());
        Assert.Equal(
            ["AccountEntityId", "AccountRef", "ConnectionId", "Currency", "Excluded", "ExternalId", "FeedSpaceId", "Id", "Provider", "SeenAt", "UserId"],
            typeof(ConnectorAccountRef).GetProperties().Select(p => p.Name).Order().ToArray());
    }

    [Fact]
    public async Task Household_agents_enrol_with_a_command_the_person_can_paste()
    {
        using var client = factory.ClientFor("agent-owner");

        using var enrol = await client.PostAsJsonAsync("/connectors/agents/enrollment", new { name = "the kitchen laptop" });
        Assert.Equal(HttpStatusCode.OK, enrol.StatusCode);
        var minted = await enrol.Content.ReadFromJsonAsync<JsonObject>();
        var code = minted!["code"]!.GetValue<string>();
        Assert.False(string.IsNullOrEmpty(code));
        Assert.Equal(ConnectorApiFactory.AgentPublicUrl, minted["controlPlaneUrl"]!.GetValue<string>());
        Assert.Contains($"ENROLLMENT_CODE={code}", minted["composeCommand"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.True(minted["expiresAt"]!.GetValue<DateTimeOffset>() > DateTimeOffset.UtcNow);

        var agents = await client.GetFromJsonAsync<JsonObject>("/connectors/agents");
        Assert.NotNull(agents!["agents"]);

        using var unknown = await client.DeleteAsync("/connectors/agents/agt_00000000000000000000000000");
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
    }

    [Fact]
    public async Task A_provider_the_catalogue_does_not_carry_is_unknown()
    {
        using var client = factory.ClientFor("unknown-provider");
        using var response = await client.PostAsJsonAsync("/connectors/no-such-provider/sync", new { connectionId = "c", bundle = "sb_v1.x" });
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<JsonObject>())!["error"]!;
        Assert.Equal("unsupported_resource", error["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_bundle_from_another_subject_does_not_sync()
    {
        using var owner = factory.ClientFor("bundle-owner");
        using var thief = factory.ClientFor("bundle-thief");
        var (_, view) = await LoginAsync(owner, MockStore, "conn-stolen");
        var bundle = view["bundle"]!.GetValue<string>();

        using var response = await thief.PostAsJsonAsync($"/connectors/{MockStore}/sync", new { connectionId = "conn-stolen", bundle });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<JsonObject>())!["error"]!;
        Assert.Equal("session_expired", error["code"]!.GetValue<string>());
        Assert.Equal("reauth", error["userAction"]!.GetValue<string>());
        Assert.False(factory.Read(db => db.ConnectorSessions.Any(s => s.ConnectionId == "conn-stolen" && s.UserId != db.Users.Single(u => u.Sub == "bundle-owner").Id)));
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /// <summary>
    /// A sync, followed to its data whichever way the relay chose to answer.
    /// A fetch that finishes inside the control plane's window comes back
    /// 200 with the counts; one that does not comes back 202 with a job the
    /// app polls and then collects with its bundle. BOTH are correct, and
    /// which one arrives depends on how loaded the machine is — the test
    /// host's one-second window makes the second routine on a CI runner. The
    /// answer is the sum: what landed inline plus what the job landed.
    /// </summary>
    private static async Task<JsonObject> SyncToTheEndAsync(HttpClient client, string provider, string connectionId, string bundle, string? since = null)
    {
        using var sync = await client.PostAsJsonAsync($"/connectors/{provider}/sync", new { connectionId, bundle, since });
        var first = await sync.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(sync.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, first!.ToJsonString());
        if (sync.StatusCode == HttpStatusCode.OK) return first;

        var jobId = first["jobId"]!.GetValue<string>();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            var job = await client.GetFromJsonAsync<JsonObject>($"/connectors/{provider}/jobs/{jobId}");
            var state = job!["state"]!.GetValue<string>();
            if (state == "succeeded") break;
            Assert.False(state is "failed" or "expired", job.ToJsonString());
            await Task.Delay(150);
        }

        using var collect = await client.PostAsJsonAsync($"/connectors/{provider}/jobs/{jobId}/collect", new { bundle });
        var collected = await collect.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(collect.StatusCode == HttpStatusCode.OK, collected!.ToJsonString());

        var ingested = new JsonObject();
        foreach (var key in new[] { "records", "receipts", "accounts", "transactions", "positions", "dropped" })
        {
            ingested[key] = (first["ingested"]?[key]?.GetValue<int>() ?? 0) + (collected["ingested"]?[key]?.GetValue<int>() ?? 0);
        }
        var body = new JsonObject
        {
            ["sessionId"] = first["sessionId"]?.GetValue<string>(),
            ["state"] = "active",
            ["ingested"] = ingested,
        };
        var session = collected["session"] ?? first["session"];
        if (session is not null) body["session"] = session.DeepClone();
        return body;
    }

    private static async Task<(HttpStatusCode Status, JsonObject View)> LoginAsync(HttpClient client, string provider, string connectionId)
    {
        using var response = await client.PostAsJsonAsync($"/connectors/{provider}/login", new
        {
            connectionId,
            inputs = Credentials,
            label = "Shop of mine",
        });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        return (response.StatusCode, view!);
    }

    /// <summary>No row of any table the API owns carries the bundle — not the binding, not a feed, not an op.</summary>
    private void AssertNothingStoredResembles(string bundle)
    {
        var fingerprint = bundle[..Math.Min(40, bundle.Length)];
        var hits = factory.Read(db =>
            db.ConnectorSessions.AsEnumerable().Count(s =>
                (s.Label ?? string.Empty).Contains(fingerprint, StringComparison.Ordinal)
                // client custody: the relay never keeps the bundle (§5.5 keeps only a household agent's pointer)
                || (s.KeptBundle ?? string.Empty).Contains(fingerprint, StringComparison.Ordinal))
            + db.EntityRows.AsEnumerable().Count(r => r.DataJson.Contains(fingerprint, StringComparison.Ordinal))
            + db.SyncOps.AsEnumerable().Count(o => o.PayloadJson.Contains(fingerprint, StringComparison.Ordinal)));
        Assert.Equal(0, hits);
    }
}
