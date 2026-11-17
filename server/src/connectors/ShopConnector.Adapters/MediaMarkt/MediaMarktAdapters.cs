using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.MediaMarkt;

/// lives in the provider's folder, not ShopAdapters, to avoid a merge on that shared file;
/// ManifestTests asserts an exact ordered list, so "mediamarkt-nl" sits between "lidl" and the mock stores
public static class MediaMarktAdapters
{
    public static IProviderAdapter Create(MediaMarktOptions? options = null, TimeProvider? time = null) =>
        new MediaMarktAdapter(options, time);
}
