using System.Net;
using System.Text.Json;
using Connector.Kit.Hosting.Data;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// raw is opt-in and rides the same row as its record: the more sensitive half, so never a default and no lifetime of its own
// the ack that purges the record purges the document with it
[Collection(ShopApiCollection.Name)]
public sealed class RawPayloadTests(ShopApiFactory factory)
{
    private const string Provider = RotatingStoreAdapter.ProviderId;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = RotatingStoreAdapter.Username,
        ["password"] = RotatingStoreAdapter.Password,
    };

    [Fact]
    public async Task A_fetch_that_asks_for_raw_gets_the_providers_own_document_beside_each_record()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await ConnectAsync(http, "raw-on");

        var page = await FetchAsync(http, connection, "include=items,raw");

        var records = page.GetProperty("data").EnumerateArray().ToList();
        Assert.NotEmpty(records);

        foreach (var record in records)
        {
            var externalId = record.GetProperty("external_id").GetString();

            Assert.Equal(externalId, record.GetProperty("raw").GetProperty("provider_said").GetString());
        }

        Assert.All(
            StagedRaw(connection.SessionId),
            raw => Assert.Contains("provider_said", raw!, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_fetch_that_does_not_ask_for_raw_stores_none_and_returns_none()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await ConnectAsync(http, "raw-off");

        var page = await FetchAsync(http, connection, "include=items");

        var records = page.GetProperty("data").EnumerateArray().ToList();
        Assert.NotEmpty(records);
        Assert.All(records, record => Assert.False(record.TryGetProperty("raw", out _)));

        Assert.All(StagedRaw(connection.SessionId), Assert.Null);
    }

    [Fact]
    public async Task A_later_fetch_without_raw_clears_what_an_earlier_one_left()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await ConnectAsync(http, "raw-cleared");

        await FetchAsync(http, connection, "include=items,raw");
        Assert.All(StagedRaw(connection.SessionId), Assert.NotNull);

        await FetchAsync(http, connection, "include=items");
        Assert.All(StagedRaw(connection.SessionId), Assert.Null);
    }

    [Fact]
    public async Task Acknowledging_the_pass_takes_the_document_with_it()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await ConnectAsync(http, "raw-ack");

        var page = await FetchAsync(http, connection, "include=items,raw");
        var cursor = page.GetProperty("cursor").GetString();

        Assert.NotEmpty(StagedRaw(connection.SessionId));

        var ticket = await Flows.ResumeAsync(http, Provider, connection);
        using var ack = await Flows.PostWithTicketAsync(
            http, $"/v1/{Provider}/receipts/ack", new { cursor }, ticket);

        Assert.Equal(HttpStatusCode.OK, ack.StatusCode);

        Assert.Equal(0, Db.StagedRows(factory, connection.SessionId));
    }

    private static Task<Connection> ConnectAsync(HttpClient http, string label) =>
        Flows.ConnectAsync(http, Provider, Flows.NewSubject(label), Credentials);

    private static async Task<JsonElement> FetchAsync(HttpClient http, Connection connection, string include)
    {
        var ticket = await Flows.ResumeAsync(http, Provider, connection);
        var since = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-30).ToString("O");

        return await Flows.FetchPageAsync(
            http, Provider, $"/v1/{Provider}/receipts?since={since}&{include}", ticket);
    }

    // read from the table: "never written" and "written then hidden on the way out" look the same through the API
    private List<string?> StagedRaw(string sessionId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();

        return [.. db.Results.Where(r => r.SessionId == sessionId).Select(r => r.RawJson)];
    }
}
