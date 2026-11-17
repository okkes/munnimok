using Connector.Kit.Adapters;
using RegistryConnector.Adapters.Bkr;
using RegistryConnector.Adapters.Duo;
using RegistryConnector.Adapters.Mock;

namespace RegistryConnector.Adapters;

// a registry holds an official record ABOUT you; a pension or student-debt balance belongs here, not in a new service
// providers are code, not rows: only a provider's health is state
public static class RegistryAdapters
{
    // the mocks are registered in every environment: the only providers exercisable end to end without an account
    public static IReadOnlyList<IProviderAdapter> All(
        RegistryAdapterOptions? options = null, TimeProvider? time = null) =>
        [.. Real(options, time), .. MockRegistryAdapters.All(time)];

    public static IReadOnlyList<IProviderAdapter> Real(
        RegistryAdapterOptions? options = null, TimeProvider? time = null)
    {
        var settings = options ?? new RegistryAdapterOptions();

        return [new BkrAdapter(settings.Bkr, time), new DuoAdapter(settings.Duo, time)];
    }
}

// every provider fact that may need correcting, bindable: an operator edit is a deploy, not a release
public sealed class RegistryAdapterOptions
{
    public BkrOptions? Bkr { get; set; }

    public DuoOptions? Duo { get; set; }
}
