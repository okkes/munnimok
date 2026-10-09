using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Sessions;
using Munni.Api.Admin;
using Munni.Api.Connectors;
using Munni.Api.Tests.Connectors;

namespace Munni.Api.Tests.Admin;

/// <summary>
/// The Bank connections dashboard (user 2026-10-09): every open-banking
/// session across users with the accounts it reached and whether it is
/// stale, every party on request, and a disconnect that ends the session
/// at the in-process control plane and forgets the binding and its
/// references — with the answer saying what the party did.
/// </summary>
public class AdminBankConnectionTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Admin = "openid profile admin";
    private const string MockBank = "mock-bank-simple";
    private const string MockStore = "mock-store-simple";

    private static readonly DateTimeOffset Yesterday = new(2026, 10, 8, 3, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task The_dashboard_lists_open_banking_sessions_per_user_and_every_party_on_request()
    {
        var alice = await MaterializeAsync("dash-alice", "Alice");
        var bob = await MaterializeAsync("dash-bob", null);
        factory.Write(db =>
        {
            db.ConnectorSessions.Add(new ConnectorSession
            {
                Id = "ses_gc_alive", UserId = alice, Provider = "gocardless", ConnectionId = "conn-gc-1", State = "active", Label = "ING",
                KeptBundle = "consent:kept-never-shown", CreatedAt = Yesterday, LastSeenAt = Yesterday, LastScheduledSyncAt = Yesterday.AddHours(1),
            });
            db.ConnectorSessions.Add(new ConnectorSession
            {
                Id = "ses_gc_dead", UserId = alice, Provider = "gocardless", ConnectionId = "conn-gc-2", State = "needs_reauth",
                LastScheduleError = "session_expired", CreatedAt = Yesterday.AddDays(-30), LastSeenAt = Yesterday.AddDays(-3),
            });
            db.ConnectorSessions.Add(new ConnectorSession
            {
                Id = "ses_eb_alive", UserId = bob, Provider = "enablebanking", ConnectionId = "conn-eb-1", State = "active",
                KeptBundle = "consent:eb", CreatedAt = Yesterday, LastSeenAt = Yesterday,
            });
            db.ConnectorAccountRefs.Add(AccountRef("acc_dash_1", alice, "gocardless", "conn-gc-1", "NL00TEST0000000001"));
            db.ConnectorAccountRefs.Add(AccountRef("acc_dash_2", alice, "gocardless", "conn-gc-1", "NL00TEST0000000002"));
        });
        // a shop connection in client custody: not a bank, listed only with every party
        using var shopper = factory.ClientFor("dash-bob");
        await LoginAsync(shopper, MockStore, "conn-shop-of-bob");

        using var admin = factory.ClientFor("the-operator", scope: Admin);
        using var response = await admin.GetAsync("/admin/bank-connections");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        var doc = JsonNode.Parse(raw)!.AsObject();
        Assert.False(doc["all"]!.GetValue<bool>());
        Assert.False(doc["capped"]!.GetValue<bool>());
        var rows = doc["connections"]!.AsArray().OfType<JsonObject>().ToList();

        var alive = rows.Single(r => r["sessionId"]!.GetValue<string>() == "ses_gc_alive");
        Assert.Equal("dash-alice", alive["userSub"]!.GetValue<string>());
        Assert.Equal("Alice", alive["userName"]!.GetValue<string>());
        Assert.Equal(2, alive["accounts"]!.GetValue<int>());
        Assert.True(alive["keptBundle"]!.GetValue<bool>());
        Assert.False(alive["stale"]!.GetValue<bool>());
        Assert.Equal("ING", alive["label"]!.GetValue<string>());
        // the bundle and the IBANs never leave: a count and a flag are all the dashboard gets
        Assert.DoesNotContain("consent:kept-never-shown", raw, StringComparison.Ordinal);
        Assert.DoesNotContain("NL00TEST0000000001", raw, StringComparison.Ordinal);

        var dead = rows.Single(r => r["sessionId"]!.GetValue<string>() == "ses_gc_dead");
        Assert.True(dead["stale"]!.GetValue<bool>());
        Assert.False(dead["keptBundle"]!.GetValue<bool>());
        Assert.Equal("session_expired", dead["lastScheduleError"]!.GetValue<string>());
        Assert.Equal(0, dead["accounts"]!.GetValue<int>());

        // no display name, no e-mail: the sub is the name
        Assert.Equal("dash-bob", rows.Single(r => r["sessionId"]!.GetValue<string>() == "ses_eb_alive")["userName"]!.GetValue<string>());
        Assert.DoesNotContain(rows, r => r["provider"]!.GetValue<string>() == MockStore);

        var every = await admin.GetFromJsonAsync<JsonObject>("/admin/bank-connections?all=true");
        Assert.True(every!["all"]!.GetValue<bool>());
        var shop = every["connections"]!.AsArray().OfType<JsonObject>().Single(r => r["provider"]!.GetValue<string>() == MockStore && r["userSub"]!.GetValue<string>() == "dash-bob");
        Assert.Equal("conn-shop-of-bob", shop["connectionId"]!.GetValue<string>());
        // active in a device's own custody: no bundle here, and not stale for it
        Assert.False(shop["stale"]!.GetValue<bool>());

        // the scope decides, not the subject
        Assert.Equal(HttpStatusCode.Forbidden, (await shopper.GetAsync("/admin/bank-connections")).StatusCode);
    }

    [Fact]
    public async Task Disconnect_ends_the_session_at_the_control_plane_and_forgets_the_binding_with_its_accounts()
    {
        const string sub = "dash-carol";
        using var client = factory.ClientFor(sub);
        var view = await LoginAsync(client, MockBank, "conn-bank-to-end");
        var sessionId = view["sessionId"]!.GetValue<string>();
        var userId = factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
        factory.Write(db =>
        {
            db.ConnectorAccountRefs.Add(AccountRef("acc_end_1", userId, MockBank, "conn-bank-to-end", "NL00TEST0000000011"));
            db.ConnectorAccountRefs.Add(AccountRef("acc_end_2", userId, MockBank, "conn-bank-to-end", "NL00TEST0000000012"));
            // another connection of the same person stays untouched
            db.ConnectorAccountRefs.Add(AccountRef("acc_keep_1", userId, MockBank, "conn-bank-kept", "NL00TEST0000000013"));
        });

        using var admin = factory.ClientFor("the-operator", scope: Admin);
        using var response = await admin.DeleteAsync($"/admin/bank-connections/{sessionId}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(SessionDisconnectOutcome.Ended, body!["party"]!.GetValue<string>());
        Assert.Equal(2, body["accountsForgotten"]!.GetValue<int>());
        Assert.Equal(MockBank, body["provider"]!.GetValue<string>());
        Assert.Equal("conn-bank-to-end", body["connectionId"]!.GetValue<string>());

        Assert.False(factory.Read(db => db.ConnectorSessions.Any(s => s.Id == sessionId)));
        Assert.Equal(["acc_keep_1"], factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == userId).Select(a => a.Id).ToList()));
        // the control plane was told: the session is off there, so a device still holding the bundle cannot resume it
        Assert.Equal(SessionState.Disabled, await factory.ControlPlane.SessionStateAsync(sessionId));
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/connectors/{MockBank}/login/{sessionId}")).StatusCode);

        // gone is gone
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync($"/admin/bank-connections/{sessionId}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.DeleteAsync($"/admin/bank-connections/{sessionId}")).StatusCode);
    }

    [Fact]
    public void A_row_is_stale_when_nothing_fetches_it_any_more()
    {
        Assert.True(AdminBankConnectionEndpoints.IsStale(Session("needs_reauth", null)));
        Assert.True(AdminBankConnectionEndpoints.IsStale(Session("failed", null)));
        Assert.True(AdminBankConnectionEndpoints.IsStale(Session("awaiting_input", null)));
        // a consent the scheduler still runs, and a device's own active session: alive
        Assert.False(AdminBankConnectionEndpoints.IsStale(Session("active", "consent")));
        Assert.False(AdminBankConnectionEndpoints.IsStale(Session("active", null)));
        Assert.False(AdminBankConnectionEndpoints.IsStale(Session("awaiting_input", "agent-pointer")));

        Assert.True(AdminBankConnectionEndpoints.IsOpenBankingParty("gocardless"));
        Assert.True(AdminBankConnectionEndpoints.IsOpenBankingParty("enablebanking"));
        Assert.True(AdminBankConnectionEndpoints.IsOpenBankingParty("mock-bank-consent"));
        Assert.False(AdminBankConnectionEndpoints.IsOpenBankingParty("ing"));
        Assert.False(AdminBankConnectionEndpoints.IsOpenBankingParty(MockStore));
    }

    private static ConnectorSession Session(string state, string? bundle) =>
        new() { Id = "ses_x", Provider = "gocardless", ConnectionId = "c", State = state, KeptBundle = bundle };

    private static ConnectorAccountRef AccountRef(string id, Guid userId, string provider, string connectionId, string iban) =>
        new()
        {
            Id = id, UserId = userId, Provider = provider, ExternalId = id, AccountRef = iban, FeedSpaceId = $"feed-{id}",
            AccountEntityId = $"acct-{id}", Currency = "EUR", ConnectionId = connectionId, SeenAt = Yesterday,
        };

    private static async Task<JsonObject> LoginAsync(HttpClient client, string provider, string connectionId)
    {
        using var response = await client.PostAsJsonAsync($"/connectors/{provider}/login", new
        {
            connectionId,
            inputs = new Dictionary<string, string> { ["username"] = "shopper", ["password"] = "hunter2" },
        });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(response.StatusCode == HttpStatusCode.OK, view!.ToJsonString());
        return view;
    }

    /// <summary>A user the api knows, named where the dashboard should show a name.</summary>
    private async Task<Guid> MaterializeAsync(string sub, string? displayName)
    {
        using var client = factory.ClientFor(sub);
        await client.GetAsync("/me");
        if (displayName is not null) factory.Write(db => db.Users.Single(u => u.Sub == sub).DisplayName = displayName);
        return factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
    }
}
