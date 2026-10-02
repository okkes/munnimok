using Connector.Kit.Security;
using ShopConnector.Adapters.Bol;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// The hash bol's page sends, read as bol sends it - and nothing that is
/// not that operation.
/// </summary>
public sealed class BolPersistedQueryTests
{
    private const string Operation = "OrdersOverviewClient";

    [Fact]
    public void The_operation_s_hash_is_read_exactly_as_the_page_spelled_it()
    {
        const string body = """
            {"operationName":"OrdersOverviewClient","variables":{"after":"0"},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"abc123DEF"}}}
            """;

        Assert.True(BolPersistedQuery.TryReadHash(body, Operation, out var hash));
        Assert.Equal("abc123DEF", hash);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json at all OrdersOverviewClient")]
    [InlineData("""{"operationName":"OtherOperation","extensions":{"persistedQuery":{"sha256Hash":"x"}}}""")]
    [InlineData("""{"operationName":"OrdersOverviewClient","extensions":{}}""")]
    [InlineData("""{"operationName":"OrdersOverviewClient","extensions":{"persistedQuery":{"sha256Hash":""}}}""")]
    public void Anything_that_is_not_the_operation_s_persisted_query_is_refused(string? body)
    {
        Assert.False(BolPersistedQuery.TryReadHash(body, Operation, out var hash));
        Assert.Equal(string.Empty, hash);
    }

    [Fact]
    public void The_hash_rides_the_session_material_and_reads_back_from_it()
    {
        var material = new SessionMaterial { StorageState = "{}" };

        Assert.Null(BolPersistedQuery.Learned(material));
        Assert.Same(material, BolPersistedQuery.WithHash(material, null));

        var sealed_ = BolPersistedQuery.WithHash(material, "sha256:feed");
        Assert.Equal("sha256:feed", BolPersistedQuery.Learned(sealed_));
        Assert.Equal("{}", sealed_.StorageState);
    }
}
