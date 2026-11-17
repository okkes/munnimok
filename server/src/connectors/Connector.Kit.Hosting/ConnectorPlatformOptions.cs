using System.Reflection;
using Connector.Kit.Adapters;
using Connector.Kit.Manifests;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Hosting;

/// kept short by design: anything a host must decide twice should be decided once in this library
public sealed class ConnectorPlatformOptions
{
    private readonly List<Action<IServiceCollection>> _adapters = [];

    public string ServiceVersion { get; set; } =
        Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "0.0.0";

    /// off in a deployment that keeps every adapter on an agent; on by default so an HTTP-tier provider needs no agent fleet
    public bool RunInlineJobs { get; set; } = true;

    /// <summary>Off only for a test that wants to drive expiry by hand.</summary>
    public bool RunExpiryService { get; set; } = true;

    /// the connector cannot see the terms the consumer showed, so it checks only that a consent was recorded and is current
    public bool RequireConsent { get; set; }

    /// <summary>The terms version a recorded consent must match, when consent is required.</summary>
    public string? ConsentTermsVersion { get; set; }

    public ConnectorPlatformOptions AddAdapter<TAdapter>()
        where TAdapter : class, IProviderAdapter
    {
        _adapters.Add(services => services.AddSingleton<IProviderAdapter, TAdapter>());
        return this;
    }

    public ConnectorPlatformOptions AddAdapter(IProviderAdapter adapter)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        _adapters.Add(services => services.AddSingleton(adapter));
        return this;
    }

    internal void Apply(IServiceCollection services)
    {
        foreach (var register in _adapters) register(services);
    }
}
