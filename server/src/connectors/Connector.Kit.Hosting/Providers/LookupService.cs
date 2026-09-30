using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Jobs;
using Microsoft.Extensions.Caching.Memory;

namespace Connector.Kit.Hosting.Providers;

/// <summary>
/// What a party lists at connect time and what the operator's account at it
/// holds (#414), reached with the platform's own provider HTTP client and no
/// session. A lookup's logos are vendored here, once a month each, so no
/// person's browser fetches from an aggregator's CDN.
/// </summary>
public sealed class LookupService(IProviderRegistry registry, IHttpClientFactory httpClients, IMemoryCache cache)
{
    private static readonly TimeSpan LogoFor = TimeSpan.FromDays(30);

    public Task<IReadOnlyList<LookupOption>> OptionsAsync(string provider, string field, LookupQuery query, CancellationToken ct) =>
        Lookup(provider).LookupAsync(Http(), field, query, ct);

    /// <summary>Null when the party has no logo for the option — remembered as such, so its absence costs one fetch a month.</summary>
    public async Task<LookupLogo?> LogoAsync(string provider, string field, string value, CancellationToken ct)
    {
        var key = $"lookup-logo:{provider}:{field}:{value}";
        if (cache.TryGetValue(key, out LookupLogo? logo)) return logo;
        logo = await Lookup(provider).LookupLogoAsync(Http(), field, value, ct).ConfigureAwait(false);
        cache.Set(key, logo, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = LogoFor, Size = logo?.Bytes.Length ?? 1 });
        return logo;
    }

    public Task<IReadOnlyList<RemoteConsent>> RemoteConsentsAsync(string provider, CancellationToken ct) =>
        Inventory(provider).ListRemoteAsync(Http(), ct);

    public Task RevokeRemoteAsync(string provider, string consentId, CancellationToken ct) =>
        Inventory(provider).RevokeRemoteAsync(Http(), consentId, ct);

    private HttpClient Http() => httpClients.CreateClient(InlineJobRunner.HttpClientName);

    private ILookupProvider Lookup(string provider)
    {
        registry.RequireManifest(provider);
        return registry.TryGetAdapter(provider, out var adapter) && adapter is ILookupProvider lookup
            ? lookup
            : throw ConnectorException.Unsupported($"{provider} lists no options at connect time");
    }

    private IRemoteInventory Inventory(string provider)
    {
        registry.RequireManifest(provider);
        return registry.TryGetAdapter(provider, out var adapter) && adapter is IRemoteInventory inventory
            ? inventory
            : throw ConnectorException.Unsupported($"{provider} keeps no inventory at the party");
    }
}
