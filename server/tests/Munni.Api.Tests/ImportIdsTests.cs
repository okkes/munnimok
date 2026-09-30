using Munni.Api.Accounts;

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
        Assert.Equal("7a851e04-b799-58c9-8b49-27ca7c6936a7", ImportIds.FeedSpaceId("NL69INGB0123456789"));
        Assert.Equal("6c267a1d-3fe2-58d5-8241-84653d30da87", ImportIds.TxMetaId("space1", "tx1"));
        Assert.Equal("1f2e3617-f88d-5266-aee7-eebe344abdc2", ImportIds.AccountLinkId("space1", "feed1"));
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
