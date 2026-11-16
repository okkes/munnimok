using System.Security.Cryptography;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Kit.Adapters;

// providers are code, not rows: the registry is built at startup and only a provider's HEALTH is state
public interface IProviderRegistry
{
    IReadOnlyList<ProviderManifest> Manifests { get; }

    bool TryGetManifest(string providerId, out ProviderManifest manifest);

    // throws rather than returning null: an unknown provider must not read as an empty result
    ProviderManifest RequireManifest(string providerId);

    // only where the process runs adapters: an agent always, the control plane only for inline-class providers
    bool TryGetAdapter(string providerId, out IProviderAdapter adapter);

    string CatalogDigest { get; }

    // the digest an agent is judged by: over the manifests an agent can be leased, raw stripped. Not CatalogDigest, which moves
    // with the control plane's inline parties (the aggregators, when the operator's keys exist) and the raw offer an agent never
    // strips: a pooled agent beside a production plane with GoCardless was listed stale and leased nothing (2026-10-01)
    string AgentCatalogDigest { get; }
}

public sealed class ProviderRegistry : IProviderRegistry
{
    private readonly Dictionary<string, ProviderManifest> _manifests;
    private readonly Dictionary<string, IProviderAdapter> _adapters;

    // false strips raw from every resource declaring it: the catalogue stops advertising it and ParamBinder refuses an include
    // value a resource does not list (invalid_request). Withheld in production: raw is the more sensitive of the two, and
    // neither service should hold everyone's unabridged purchase history; diagnosing a shape change is for development
    public ProviderRegistry(IEnumerable<IProviderAdapter> adapters, bool offerRawPayloads = true)
    {
        ArgumentNullException.ThrowIfNull(adapters);

        _adapters = new Dictionary<string, IProviderAdapter>(StringComparer.Ordinal);
        _manifests = new Dictionary<string, ProviderManifest>(StringComparer.Ordinal);

        foreach (var adapter in adapters)
        {
            var described = adapter.Describe();
            var manifest = offerRawPayloads ? described : WithoutRawPayloads(described);

            // Validated after the strip, so what is served is what was
            // checked.
            ManifestValidator.Validate(manifest);

            if (!_manifests.TryAdd(manifest.Id, manifest))
            {
                throw new InvalidOperationException($"duplicate provider id '{manifest.Id}'");
            }

            _adapters[manifest.Id] = adapter;
        }

        Manifests = [.. _manifests.Values.OrderBy(m => m.Id, StringComparer.Ordinal)];
        CatalogDigest = ComputeDigest(Manifests);
        AgentCatalogDigest = ComputeDigest(AgentServed(Manifests));
    }

    public IReadOnlyList<ProviderManifest> Manifests { get; }

    public string CatalogDigest { get; }

    public string AgentCatalogDigest { get; }

    // the canonical shape AgentCatalogDigest is computed over on both sides
    public static IReadOnlyList<ProviderManifest> AgentServed(IEnumerable<ProviderManifest> manifests)
    {
        ArgumentNullException.ThrowIfNull(manifests);

        return
        [
            .. manifests
                .Where(m => m.Agent.Required || m.Agent.Class != AgentClass.Inline)
                .Select(WithoutRawPayloads)
                .OrderBy(m => m.Id, StringComparer.Ordinal),
        ];
    }

    public bool TryGetManifest(string providerId, out ProviderManifest manifest) =>
        _manifests.TryGetValue(providerId, out manifest!);

    public ProviderManifest RequireManifest(string providerId) =>
        _manifests.TryGetValue(providerId, out var m)
            ? m
            : throw ConnectorException.Unsupported($"unknown provider '{providerId}'");

    // a resource that never offered raw is returned as-is, so the catalogue ETag moves only for providers that lost a value
    private static ProviderManifest WithoutRawPayloads(ProviderManifest manifest) => manifest with
    {
        Resources = [.. manifest.Resources.Select(WithoutRawPayloads)],
    };

    private static ResourceSpec WithoutRawPayloads(ResourceSpec resource) => resource with
    {
        Params = [.. resource.Params.Select(WithoutRawPayloads)],
    };

    private static ParamSpec WithoutRawPayloads(ParamSpec param) =>
        param.Key == ResourceRequest.IncludeParam
        && param.Values is { } values
        && values.Contains(ResourceRequest.RawInclude, StringComparer.Ordinal)
            ? param with
            {
                Values = [.. values.Where(v => v != ResourceRequest.RawInclude)],
            }
            : param;

    public bool TryGetAdapter(string providerId, out IProviderAdapter adapter) =>
        _adapters.TryGetValue(providerId, out adapter!);

    // hashes the catalogue as a consumer receives it (wire-option bytes), not id:manifest_version pairs: most changes do
    // not bump ManifestVersion (sealed into bundles as AAD, so bumping invalidates every credential), and a stale ETag
    // kept consumers rendering a form the service had stopped accepting
    private static string ComputeDigest(IReadOnlyList<ProviderManifest> manifests)
    {
        var seed = JsonSerializer.SerializeToUtf8Bytes(manifests, ConnectorWireJson.Options);
        var digest = SHA256.HashData(seed);
        return "sha256:" + Convert.ToHexStringLower(digest);
    }
}
