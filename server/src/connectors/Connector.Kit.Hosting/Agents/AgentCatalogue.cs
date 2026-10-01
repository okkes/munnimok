using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;

namespace Connector.Kit.Hosting.Agents;

/// <summary>
/// Whether an agent runs the adapter catalogue this control plane runs.
///
/// Both sides compute the same digest over the manifests they registered,
/// so equal digests mean the same adapter code configured the same way -
/// the same login forms, selectors and record shapes the catalogue
/// documents. An agent that differs is alive and enrolled and is leased
/// nothing; one that made no claim is not checked, and every agent this
/// repository builds makes the claim.
/// </summary>
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
