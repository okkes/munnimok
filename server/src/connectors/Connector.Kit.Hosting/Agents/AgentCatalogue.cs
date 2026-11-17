using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;

namespace Connector.Kit.Hosting.Agents;

/// equal digests mean the same adapter code configured the same way; a differing agent is leased nothing
/// an agent that made no claim is not checked
public static class AgentCatalogue
{
    public static bool IsStale(AgentCapabilities capabilities, IProviderRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(capabilities);
        ArgumentNullException.ThrowIfNull(registry);

        // The agent-served digest, not the catalogue's: see IProviderRegistry.AgentCatalogDigest
        return capabilities.CatalogDigest is { Length: > 0 } theirs
               && !string.Equals(theirs, registry.AgentCatalogDigest, StringComparison.Ordinal);
    }
}
