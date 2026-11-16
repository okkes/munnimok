using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Security;
using Microsoft.Playwright;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Jumbo;
using ShopConnector.Adapters.Tests.Support;

namespace ShopConnector.Adapters.Tests;

// answers by operation name (and by id for the two detail calls),
// so tests do not depend on the order the fetch loop calls in
internal sealed class FakeJumboGraphQl : IJumboGraphQlClient
{
    private readonly string[] _listPages;
    private readonly List<JumboGraphQlRequest> _calls = [];
    private readonly List<string?> _deviceIds = [];

    private int _listCalls;

    public FakeJumboGraphQl(params string[] listPages) =>
        _listPages = listPages.Length > 0 ? listPages : [FixtureCatalog.Read("jumbo/orders-and-receipts.json")];

    /// <summary>Keyed by order id; <c>*</c> answers anything else.</summary>
    public Dictionary<string, string> OrderDetails { get; } = new(StringComparer.Ordinal);

    /// <summary>Keyed by transaction id; <c>*</c> answers anything else.</summary>
    public Dictionary<string, string> DigitalReceipts { get; } = new(StringComparer.Ordinal);

    public IReadOnlyList<JumboGraphQlRequest> Calls => _calls;

    public IReadOnlyList<string?> DeviceIds => _deviceIds;

    public IReadOnlyList<JumboGraphQlRequest> ListCalls =>
        [.. _calls.Where(c => string.Equals(c.OperationName, "GetOnlineOrdersAndStoreReceipts", StringComparison.Ordinal))];

    public static FakeJumboGraphQl Recorded(params string[] listPages)
    {
        var fake = new FakeJumboGraphQl(listPages);

        fake.OrderDetails["90211"] = FixtureCatalog.Read("jumbo/order-detail.json");
        fake.OrderDetails["90118"] = FixtureCatalog.Read("jumbo/order-detail-90118.json");
        fake.OrderDetails["*"] = FixtureCatalog.Read("jumbo/order-detail.json");
        fake.DigitalReceipts["*"] = FixtureCatalog.Read("jumbo/digital-receipt.json");

        return fake;
    }

    public Task<JsonDocument> ExecuteAsync(
        IJobContext ctx, JumboGraphQlRequest request, string? deviceId, CancellationToken ct)
    {
        _calls.Add(request);
        _deviceIds.Add(deviceId);

        var body = request.OperationName switch
        {
            "GetOnlineOrdersAndStoreReceipts" => _listPages[Math.Min(_listCalls++, _listPages.Length - 1)],
            "OrderPagesOrder" => Lookup(OrderDetails, Variable(request, "orderId"), request.OperationName),
            "GetDigitalReceipt" => Lookup(DigitalReceipts, Variable(request, "transactionId"), request.OperationName),
            _ => throw new InvalidOperationException($"unexpected operation '{request.OperationName}'"),
        };

        return Task.FromResult(JsonDocument.Parse(body));
    }

    private static string Variable(JumboGraphQlRequest request, string name) =>
        request.Variables.TryGetPropertyValue(name, out var node) && node is not null
            ? node.ToJsonString().Trim('"')
            : string.Empty;

    private static string Lookup(Dictionary<string, string> bodies, string key, string operation)
    {
        if (bodies.TryGetValue(key, out var exact)) return exact;
        if (bodies.TryGetValue("*", out var fallback)) return fallback;

        throw new InvalidOperationException($"no recorded body for {operation}('{key}')");
    }
}

// a page holding a secret yields no bytes, as the agent's redactor does: a picture back proves the password was gone first
internal sealed class JumboBrowserLease : IBrowserLease
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

    private readonly StubLoginPage _page;
    private readonly string _storageState;

    public JumboBrowserLease(StubLoginPage page, string? storageState = null)
    {
        _page = page;
        _storageState = storageState ?? FixtureCatalog.Read("jumbo/storage-state.json");
    }

    public bool Started => true;

    public int Captures { get; private set; }

    public CropRegion? LastCrop { get; private set; }

    public Task<IPage> PageAsync(CancellationToken ct) =>
        throw new InvalidOperationException("this test drives the page through the adapter's seam");

    public Task<string> StorageStateAsync(CancellationToken ct) => Task.FromResult(_storageState);

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct)
    {
        Captures++;
        LastCrop = crop;
        _page.Record("screenshot");

        return Task.FromResult(_page.HoldsSecret ? Array.Empty<byte>() : Png);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

internal static class JumboFixtures
{
    public static SessionMaterial LiveSession => new()
    {
        StorageState = FixtureCatalog.Read("jumbo/storage-state.json"),
        DeviceId = "device-fixture",
    };

    public static IReadOnlyDictionary<string, string> Credentials { get; } =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "shopper@example.test",
            ["password"] = "correct horse battery staple",
        };

    public static JsonNode OrdersFixture() =>
        JsonNode.Parse(FixtureCatalog.Read("jumbo/orders-and-receipts.json"))!;

    public static JsonArray Orders(JsonNode root) => root["data"]!["onlineOrders"]!["orders"]!.AsArray();

    public static JsonArray StoreReceipts(JsonNode root) => root["data"]!["storeReceipts"]!["receipts"]!.AsArray();
}
