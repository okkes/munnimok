using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Fixtures;

namespace ShopConnector.Adapters.Tests.Support;

/// mutations start from the recorded payload, so a drifting fixture breaks these tests too
internal static class Fixture
{
    public static JsonDocument Doc(string name) => JsonDocument.Parse(FixtureCatalog.Read(name));

    public static JsonNode Node(string name) =>
        JsonNode.Parse(FixtureCatalog.Read(name))
        ?? throw new InvalidOperationException($"fixture '{name}' parsed to null");

    public static JsonObject Object(string name) =>
        Node(name) as JsonObject
        ?? throw new InvalidOperationException($"fixture '{name}' is not a JSON object");

    public static JsonArray Array(string name) =>
        Node(name) as JsonArray
        ?? throw new InvalidOperationException($"fixture '{name}' is not a JSON array");

    public static JsonDocument Reparse(JsonNode node) => JsonDocument.Parse(node.ToJsonString());
}

internal static class Requests
{
    /// items defaults on because the reconciliation invariant is checked against line items and discounts
    public static ResourceRequest Receipts(
        DateOnly? since = null, DateOnly? until = null, bool items = true, bool raw = false, bool invoice = false)
    {
        List<string> include = [];
        if (items) include.Add("items");
        if (raw) include.Add("raw");
        if (invoice) include.Add(ResourceRequest.InvoiceInclude);

        return new ResourceRequest
        {
            ResourceId = "receipts",
            Since = since,
            Until = until,
            Selections = include.Count == 0
                ? new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                : new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                {
                    ["include"] = include,
                },
        };
    }

    public static DateOnly Day(int year, int month, int day) => new(year, month, day);
}
