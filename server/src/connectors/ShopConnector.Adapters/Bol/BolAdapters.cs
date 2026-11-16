using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.Bol;

// a factory of its own: several providers were being added at once and ShopAdapters.Real is where they collided
public static class BolAdapters
{
    public static IProviderAdapter Create(BolOptions? options = null, TimeProvider? time = null) =>
        new BolAdapter(options, time);
}
