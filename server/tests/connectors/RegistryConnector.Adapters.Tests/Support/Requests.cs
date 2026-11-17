using Connector.Kit.Jobs;
using RegistryConnector.Adapters.Mock;

namespace RegistryConnector.Adapters.Tests;

internal static class Requests
{
    // no date range: a register has none to give
    public static ResourceRequest Credits() => new()
    {
        ResourceId = MockRegistryAdapter.CreditsResource,
        Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal),
    };
}
