using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.MediaMarkt;

/// <summary>
/// The registration entry point for MediaMarkt.
///
/// It lives here rather than in <c>ShopAdapters</c> because that file is the one
/// shared surface several adapters are added through at once, and a factory in
/// the provider's own folder is a merge nobody has to resolve.
///
/// One thing follows from registering it:
/// <c>ManifestTests.Registry_registers_every_shop_provider</c> asserts an exact
/// ordered list and the registry sorts by id, so <c>"mediamarkt-nl"</c> belongs
/// between <c>"lidl"</c> and the mock stores.
/// </summary>
public static class MediaMarktAdapters
{
    /// <summary>The single provider this folder registers.</summary>
    public static IProviderAdapter Create(MediaMarktOptions? options = null, TimeProvider? time = null) =>
        new MediaMarktAdapter(options, time);
}
