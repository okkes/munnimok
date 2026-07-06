using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;
using Munni.Api.GoCardless;

namespace Munni.Api.Tests;

public class ImportIdsTests
{
    [Fact]
    public void MatchesJsUuidV5Exactly()
    {
        // reference values computed with the JS `uuid` package and the same
        // namespace — cross-source dedupe depends on byte-exact equality
        Assert.Equal("7fd11b1d-fe03-5861-b867-cc94677242a0", ImportIds.AccountId("NL69INGB0123456789"));
        Assert.Equal("897f58a0-87b1-58b3-b18a-1c4ce075f18f", ImportIds.TransactionId("NL69INGB0123456789", "REF-001"));
    }

    [Fact]
    public void NormalizesIbanLikeTheClient()
    {
        Assert.Equal(ImportIds.AccountId("nl69 ingb 0123 4567 89"), ImportIds.AccountId("NL69INGB0123456789"));
    }
}

public class KeywordPredictorTests
{
    [Fact]
    public void PredictsDutchGroceryDebit()
    {
        var p = KeywordPredictor.Predict("Albert Heijn 1350 AMSTERDAM", "debit");
        Assert.Equal("groceries", p!.CatId);
        Assert.Equal("expense", p.TxType);
    }

    [Fact]
    public void PredictsSalaryOnlyOnCredit()
    {
        Assert.Equal("salary", KeywordPredictor.Predict("SALARIS JUNI", "credit")!.CatId);
        Assert.NotEqual("salary", KeywordPredictor.Predict("SALARIS JUNI", "debit")?.CatId);
    }

    [Fact]
    public void ReturnsNullWhenNothingMatches()
    {
        Assert.Null(KeywordPredictor.Predict("xyzzy qwerty", "debit"));
    }
}

public class GcIngestTests
{
    private static AppDbContext NewDb() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"gc_{Guid.NewGuid():N}").Options);

    private static readonly GcAccountDetails Details = new("NL69INGB0123456789", "Betaalrekening", "EUR");
    private static readonly List<GcBalance> Balances = [new(new GcAmount("1234.56", "EUR"), "closingBooked")];
    private static readonly List<GcTransaction> Transactions =
    [
        new("BANKREF-1", null, "2026-07-05", null, new GcAmount("-42.10", "EUR"), "Albert Heijn", null, "AH 1350 AMSTERDAM"),
        new("BANKREF-2", null, "2026-07-04", null, new GcAmount("2200.00", "EUR"), null, "Werkgever BV", "SALARIS JUNI"),
        new("BANKREF-3", null, "2026-07-03", null, new GcAmount("-9.99", "EUR"), "Onbekend XQZ", null, "QWERTY"),
    ];

    private static GcLinkedAccount Linked(string spaceId) => new()
    {
        GcAccountId = "gc-acc-1",
        SpaceId = spaceId,
        AccountEntityId = ImportIds.AccountId("NL69INGB0123456789"),
        Iban = "NL69INGB0123456789",
        Currency = "EUR",
    };

    [Fact]
    public async Task IngestCreatesAccountAndCategorizedTransactions()
    {
        await using var db = NewDb();
        var space = new Space { Id = "s1" };
        db.Spaces.Add(space);
        await db.SaveChangesAsync();

        var accepted = await new GcIngest(db).IngestAccountAsync(space, Linked("s1"), Details, Balances, Transactions);
        await db.SaveChangesAsync();
        Assert.Equal(4, accepted); // 1 account + 3 txs

        var account = await db.EntityRows.FindAsync("s1", "account", ImportIds.AccountId("NL69INGB0123456789"));
        var accountData = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(account!.DataJson)!;
        Assert.Equal(123456, accountData["balanceCents"].GetInt32());
        Assert.Equal("gocardless", accountData["source"].GetString());

        var groceriesTx = await db.EntityRows.FindAsync("s1", "transaction", ImportIds.TransactionId("NL69INGB0123456789", "BANKREF-1"));
        var txData = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(groceriesTx!.DataJson)!;
        Assert.Equal("groceries", txData["catId"].GetString());
        Assert.Equal(0, txData["needsReview"].GetInt32());

        var unknownTx = await db.EntityRows.FindAsync("s1", "transaction", ImportIds.TransactionId("NL69INGB0123456789", "BANKREF-3"));
        var unknownData = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(unknownTx!.DataJson)!;
        Assert.Equal("uncategorized", unknownData["catId"].GetString());
        Assert.Equal(1, unknownData["needsReview"].GetInt32());
    }

    [Fact]
    public async Task RefetchIsIdempotent()
    {
        await using var db = NewDb();
        var space = new Space { Id = "s1" };
        db.Spaces.Add(space);
        await db.SaveChangesAsync();

        var ingest = new GcIngest(db);
        var linked = Linked("s1");
        await ingest.IngestAccountAsync(space, linked, Details, Balances, Transactions);
        await db.SaveChangesAsync();
        var secondRun = await ingest.IngestAccountAsync(space, linked, Details, Balances, Transactions);
        await db.SaveChangesAsync();

        // account op has a per-day seed (accepted again is fine at most 0-1);
        // transactions must never duplicate
        Assert.True(secondRun <= 1);
        Assert.Equal(3, await db.EntityRows.CountAsync(r => r.SpaceId == "s1" && r.Entity == "transaction"));
    }
}
