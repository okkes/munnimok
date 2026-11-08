using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using BankConnector.Adapters.MockBank;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// Which account a fetched record is, and whose connection fetches it:
/// a wallet the party names across consents lands on the account an earlier
/// consent filed (#491), the relay lists per person which accounts each
/// connection reaches (#524), and the platform's stand-in parties stay out
/// of what people are offered (#526).
/// </summary>
public class ConnectorAccountIdentityTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Consent = MockBankConsentAdapter.ProviderId;

    private static JsonObject Wallet(string id, string externalId, string? identity) => new()
    {
        ["id"] = id,
        ["external_id"] = externalId,
        ["display_name"] = "PayPal",
        ["currency"] = "EUR",
        ["type"] = "current",
        ["identity"] = identity,
    };

    private async Task<Guid> UserAsync(string sub)
    {
        using var client = factory.ClientFor(sub);
        Assert.True((await client.GetAsync("/connectors")).IsSuccessStatusCode);   // provisions the user
        return factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
    }

    [Fact]
    public async Task A_wallet_a_new_consent_reaches_lands_on_the_account_the_earlier_consent_filed_and_retires_it()
    {
        var userId = await UserAsync("identity-reconnect");
        factory.Write(db => db.ConnectorSessions.AddRange(
            new ConnectorSession { Id = "ses_id_old", UserId = userId, Provider = Consent, ConnectionId = "conn-id-old", State = "active" },
            new ConnectorSession { Id = "ses_id_new", UserId = userId, Provider = Consent, ConnectionId = "conn-id-new", State = "active" }));
        using var scope = factory.Services.CreateScope();
        var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();
        var ct = CancellationToken.None;

        await ingest.IngestAsync(userId, Consent, "Mock", "conn-id-old", "account", [Wallet("acc_id_old", "uid-old", "hash-paypal")], ct);
        var old = factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_id_old"));
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-id-new", "account", [Wallet("acc_id_new", "uid-new", "hash-paypal")], ct);

        var refs = factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == userId).ToList());
        var fresh = Assert.Single(refs);
        // one account, whatever the consent's own ids
        Assert.Equal("acc_id_new", fresh.Id);
        Assert.Equal(old.AccountRef, fresh.AccountRef);
        Assert.Equal(old.FeedSpaceId, fresh.FeedSpaceId);
        Assert.Equal(old.AccountEntityId, fresh.AccountEntityId);
        Assert.Equal("hash-paypal", fresh.Identity);
        // the identity proves the account is the same one: the session the reconnect left behind goes, with its references
        Assert.Equal(["ses_id_new"], factory.Read(db => db.ConnectorSessions.Where(s => s.UserId == userId).Select(s => s.Id).ToList()));
    }

    [Fact]
    public async Task A_consent_read_before_identities_keeps_its_account_and_lends_it_to_the_next_consent()
    {
        var userId = await UserAsync("identity-backfill");
        using var scope = factory.Services.CreateScope();
        var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();
        var ct = CancellationToken.None;

        // filed per session, as every wallet was before the party's identity was read
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-bf-a", "account", [Wallet("acc_bf_a", "uid-a", null)], ct);
        var before = factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_bf_a"));
        Assert.Equal($"CONN:{Consent}:uid-a", before.AccountRef);

        // the same consent, now with its identity: the account stays where it was
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-bf-a", "account", [Wallet("acc_bf_a", "uid-a", "hash-bf")], ct);
        var stamped = factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_bf_a"));
        Assert.Equal(before.AccountRef, stamped.AccountRef);
        Assert.Equal("hash-bf", stamped.Identity);

        // a later consent of the same wallet continues that account
        await ingest.IngestAsync(userId, Consent, "Mock", "conn-bf-b", "account", [Wallet("acc_bf_b", "uid-b", "hash-bf")], ct);
        Assert.Equal(before.AccountRef, factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_bf_b")).AccountRef);
    }

    [Fact]
    public async Task A_new_wallet_with_an_identity_is_filed_under_it()
    {
        var userId = await UserAsync("identity-first");
        using var scope = factory.Services.CreateScope();
        var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();

        await ingest.IngestAsync(userId, Consent, "Mock", "conn-first", "account", [Wallet("acc_first", "uid-first", "hash-first")], CancellationToken.None);

        Assert.Equal($"CONN:{Consent}:hash-first", factory.Read(db => db.ConnectorAccountRefs.Single(a => a.Id == "acc_first")).AccountRef);
    }

    [Fact]
    public async Task The_relay_lists_per_person_which_accounts_each_connection_reaches()
    {
        var userId = await UserAsync("accounts-owner");
        var otherId = await UserAsync("accounts-stranger");
        factory.Write(db => db.ConnectorAccountRefs.AddRange(
            new ConnectorAccountRef { Id = "acc_ls_1", UserId = userId, Provider = "enablebanking", ExternalId = "x1", ConnectionId = "conn-ls-paypal", AccountRef = "CONN:enablebanking:h1", FeedSpaceId = "feed-paypal", AccountEntityId = "acct-paypal", Currency = "EUR" },
            // a second session of the same connection reaching the same account: listed once
            new ConnectorAccountRef { Id = "acc_ls_1b", UserId = userId, Provider = "enablebanking", ExternalId = "x1b", ConnectionId = "conn-ls-paypal", AccountRef = "CONN:enablebanking:h1", FeedSpaceId = "feed-paypal", AccountEntityId = "acct-paypal", Currency = "EUR" },
            new ConnectorAccountRef { Id = "acc_ls_2", UserId = userId, Provider = "enablebanking", ExternalId = "x2", ConnectionId = "conn-ls-ing", AccountRef = "NL74INGB0001029507", FeedSpaceId = "feed-ing", AccountEntityId = "acct-ing", Currency = "EUR" },
            // dropped by the person, and one without a connection: neither is fetched for them
            new ConnectorAccountRef { Id = "acc_ls_3", UserId = userId, Provider = "enablebanking", ExternalId = "x3", ConnectionId = "conn-ls-ing", AccountRef = "NL00INGB0000000003", FeedSpaceId = "feed-gone", AccountEntityId = "acct-gone", Currency = "EUR", Excluded = true },
            new ConnectorAccountRef { Id = "acc_ls_4", UserId = userId, Provider = "enablebanking", ExternalId = "x4", AccountRef = "NL00INGB0000000004", FeedSpaceId = "feed-none", AccountEntityId = "acct-none", Currency = "EUR" },
            // somebody else's connection to the same IBAN feed
            new ConnectorAccountRef { Id = "acc_ls_5", UserId = otherId, Provider = "enablebanking", ExternalId = "x5", ConnectionId = "conn-ls-theirs", AccountRef = "NL74INGB0001029507", FeedSpaceId = "feed-ing", AccountEntityId = "acct-ing", Currency = "EUR" }));

        using var client = factory.ClientFor("accounts-owner");
        var rows = await client.GetFromJsonAsync<JsonArray>("/connectors/accounts");

        var listed = rows!.Select(r => $"{r!["connectionId"]}|{r["provider"]}|{r["feedSpaceId"]}|{r["accountId"]}").ToList();
        Assert.Equal(["conn-ls-ing|enablebanking|feed-ing|acct-ing", "conn-ls-paypal|enablebanking|feed-paypal|acct-paypal"], listed);
    }

    [Fact]
    public async Task The_stand_in_parties_are_left_out_of_what_people_are_offered_and_cannot_be_signed_in_to()
    {
        // the test host offers them (it drives the protocol through them); an environment does not
        using var plain = factory.WithWebHostBuilder(builder => builder.UseSetting("Connectors:OfferFixtures", "false"));
        using var client = plain.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", "fixture-shopper");
        client.DefaultRequestHeaders.Add("X-Munni-Device", "device-fixture");

        var catalogue = await client.GetFromJsonAsync<JsonObject>("/connectors/providers");
        var ids = catalogue!["providers"]!.AsArray().Select(p => p!["id"]!.GetValue<string>()).ToList();
        Assert.DoesNotContain(ids, id => id.StartsWith("mock-", StringComparison.Ordinal));

        using var login = await client.PostAsJsonAsync("/connectors/mock-store-simple/login", new { connectionId = "conn-fixture", inputs = new { username = "u", password = "p" } });
        Assert.Equal(HttpStatusCode.NotFound, login.StatusCode);
        Assert.Equal("unsupported_resource", (await login.Content.ReadFromJsonAsync<JsonObject>())!["error"]!["code"]!.GetValue<string>());

        // the test host's own catalogue still lists them, marked
        using var offered = factory.ClientFor("fixture-tester");
        var all = await offered.GetFromJsonAsync<JsonObject>("/connectors/providers");
        var mock = all!["providers"]!.AsArray().Single(p => p!["id"]!.GetValue<string>() == "mock-store-simple")!;
        Assert.True(mock["fixture"]!.GetValue<bool>());
    }
}
