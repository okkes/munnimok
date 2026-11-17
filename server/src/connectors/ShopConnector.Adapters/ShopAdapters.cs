using Connector.Kit.Adapters;
using ShopConnector.Adapters.AlbertHeijn;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Coolblue;
using ShopConnector.Adapters.Jumbo;
using ShopConnector.Adapters.LidlPlus;
using ShopConnector.Adapters.MediaMarkt;
using ShopConnector.Adapters.Mock;

namespace ShopConnector.Adapters;

/// providers are code, not rows: the registry is built at startup from this and refuses to boot on a bad manifest
public static class ShopAdapters
{
    /// the mocks register in every environment on purpose: only they can be exercised end to end without an account
    public static IReadOnlyList<IProviderAdapter> All(ShopAdapterOptions? options = null, TimeProvider? time = null) =>
        [.. Real(options, time), .. MockStoreAdapters.All(options?.Mock, time)];

    public static IReadOnlyList<IProviderAdapter> Real(
        ShopAdapterOptions? options = null, TimeProvider? time = null)
    {
        var settings = options ?? new ShopAdapterOptions();

        return
        [
            // AH and Lidl drive a browser once; Jumbo's session is a ~24h cookie, so it drives one whenever it has gone stale
            new AlbertHeijnAdapter(settings.Ah, time),
            new LidlPlusAdapter(settings.Lidl, time),
            new JumboAdapter(settings.Jumbo, graphql: null, time),

            BolAdapters.Create(settings.Bol, time),
            CoolblueAdapters.Create(settings.Coolblue, time),
            AmazonAdapters.Create(settings.Amazon, time),
            MediaMarktAdapters.Create(settings.MediaMarkt, time),
        ];
    }
}

/// every provider's unconfirmed values (endpoints, client ids, selectors, money units) are bindable here: a fix is a
/// deploy-time edit, not a release
public sealed record ShopAdapterOptions
{
    public AlbertHeijnOptions Ah { get; init; } = new();

    public LidlPlusOptions Lidl { get; init; } = new();

    public JumboOptions Jumbo { get; init; } = new();

    public BolOptions Bol { get; init; } = new();

    public CoolblueOptions Coolblue { get; init; } = new();

    public AmazonOptions Amazon { get; init; } = new();

    public MediaMarktOptions MediaMarkt { get; init; } = new();

    public MockStoreOptions Mock { get; init; } = new();
}
