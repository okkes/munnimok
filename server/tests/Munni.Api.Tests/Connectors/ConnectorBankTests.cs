using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Accounts;

namespace Munni.Api.Tests.Connectors;

/// <summary>M4 (#311 r4): a statement import owning an IBAN's canonical account row makes the bank bind its own row
/// until the explicit merge. Own fixture: a seeded import row must not collide with the relay suite's syncs.</summary>
public class ConnectorBankTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string MockBank = "mock-bank-simple";

    /// <summary>the mock ledger's current account (<c>MockBankLedger.CurrentIban</c>)</summary>
    private const string CurrentIban = "NL18MOCK0123456789";

    [Fact]
    public async Task A_bank_beside_a_statement_import_of_the_same_iban_keeps_its_own_row_until_the_merge()
    {
        const string sub = "bank-forker";
        var feedId = ImportIds.FeedSpaceId(CurrentIban);
        var canonical = ImportIds.AccountId(CurrentIban);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.EntityRows.Add(new EntityRow
            {
                SpaceId = feedId,
                Entity = "account",
                EntityId = canonical,
                Deleted = false,
                DataJson = "{\"source\":\"camt053\",\"name\":\"Mijn rekening\"}",
                FieldVersionsJson = "{}",
            });
            await db.SaveChangesAsync();
        }

        using var client = factory.ClientFor(sub);
        using var login = await client.PostAsJsonAsync($"/connectors/{MockBank}/login", new
        {
            connectionId = "conn-bank-fork",
            // the mock's username pattern wants a real-looking name; any password but its rejected one works
            inputs = new Dictionary<string, string> { ["username"] = "shopper", ["password"] = "hunter2" },
        });
        var view = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(login.StatusCode == HttpStatusCode.OK, view!.ToJsonString());
        var bundle = view["bundle"]!.GetValue<string>();

        var body = await SyncToTheEndAsync(client, bundle);
        Assert.True(body["ingested"]!["accounts"]!.GetValue<int>() > 0, body.ToJsonString());

        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var reference = factory.Read(db => db.ConnectorAccountRefs.Single(a => a.UserId == user.Id && a.AccountRef == CurrentIban));
        Assert.Equal(ImportIds.BankAccountId(CurrentIban), reference.AccountEntityId);
        Assert.Equal(feedId, reference.FeedSpaceId);

        var importRow = factory.Read(db => db.EntityRows.Single(r => r.SpaceId == feedId && r.Entity == "account" && r.EntityId == canonical));
        Assert.Contains("camt053", importRow.DataJson);
        var bankRow = factory.Read(db => db.EntityRows.Single(r => r.SpaceId == feedId && r.Entity == "account" && r.EntityId == ImportIds.BankAccountId(CurrentIban)));
        var data = JsonDocument.Parse(bankRow.DataJson).RootElement;
        Assert.Equal(ConnectorIngest.Source, data.GetProperty("source").GetString());
        Assert.Equal(MockBank, data.GetProperty("provider").GetString());
        Assert.Equal(CurrentIban, data.GetProperty("iban").GetString());
        // #445: the connection that fetched the row, for the app to read against the ones that still exist
        Assert.Equal("conn-bank-fork", data.GetProperty("connectionId").GetString());

        var transactions = factory.Read(db => db.EntityRows.Where(r => r.SpaceId == feedId && r.Entity == "transaction").ToList());
        Assert.NotEmpty(transactions);
        Assert.All(transactions, tx =>
            Assert.Equal(ImportIds.BankAccountId(CurrentIban), JsonDocument.Parse(tx.DataJson).RootElement.GetProperty("accountId").GetString()));
    }

    private static async Task<JsonObject> SyncToTheEndAsync(HttpClient client, string bundle)
    {
        using var sync = await client.PostAsJsonAsync($"/connectors/{MockBank}/sync", new { connectionId = "conn-bank-fork", bundle });
        var first = await sync.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(sync.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, first!.ToJsonString());
        if (sync.StatusCode == HttpStatusCode.OK) return first;

        var jobId = first["jobId"]!.GetValue<string>();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            var job = await client.GetFromJsonAsync<JsonObject>($"/connectors/{MockBank}/jobs/{jobId}");
            var state = job!["state"]!.GetValue<string>();
            if (state == "succeeded") break;
            Assert.False(state is "failed" or "expired", job.ToJsonString());
            await Task.Delay(150);
        }

        using var collect = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{jobId}/collect", new { bundle });
        var collected = await collect.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(collect.StatusCode == HttpStatusCode.OK, collected!.ToJsonString());
        var ingested = new JsonObject();
        foreach (var key in new[] { "records", "receipts", "accounts", "transactions", "positions", "dropped" })
        {
            ingested[key] = (first["ingested"]?[key]?.GetValue<int>() ?? 0) + (collected["ingested"]?[key]?.GetValue<int>() ?? 0);
        }
        return new JsonObject { ["ingested"] = ingested };
    }
}
