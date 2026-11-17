using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.Coolblue;

/// Lives in the provider's folder, not ShopAdapters, so the shared file needs no merge. ManifestTests.
/// Registry_registers_every_shop_provider asserts an ordered list sorted by id: "coolblue" sits between "ah" and "jumbo".
public static class CoolblueAdapters
{
    public static IProviderAdapter Create(CoolblueOptions? options = null, TimeProvider? time = null) =>
        new CoolblueAdapter(options, time);
}
