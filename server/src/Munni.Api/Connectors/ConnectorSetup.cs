using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Munni.Api.Connectors;

/// <summary>
/// Registers the relay when — and only when — this environment names a
/// control plane. Follows <c>BankingSetup.Register</c>: an unconfigured
/// connector is simply absent, never a silent stand-in.
/// </summary>
public static class ConnectorSetup
{
    public static bool Register(IServiceCollection services, IConfiguration config)
    {
        var options = config.GetSection(ConnectorOptions.SectionName).Get<ConnectorOptions>() ?? new ConnectorOptions();
        if (!options.Configured) return false;
        options.Require();

        services.AddSingleton(options);
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton(new SubjectMinter(options.SubjectSalt!));
        services.AddSingleton<ConnectorAuthSource>();
        services.AddSingleton<ConnectorBudget>();
        services.AddSingleton<ConnectorEventBridge>();
        services.AddSingleton<ConnectorCatalogue>();
        services.AddScoped<ConnectorRelay>();
        services.AddScoped<ConnectorIngest>();
        services.AddScoped<ConnectorSyncService>();
        services.AddHttpClient<ConnectorClient>(client =>
        {
            client.BaseAddress = options.BaseAddress();
            client.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
        });
        return true;
    }

    /// <summary>Maps the relay and its operator routes when the environment runs connectors; nothing otherwise.</summary>
    public static void Map(IEndpointRouteBuilder app, bool enabled)
    {
        if (!enabled) return;
        app.MapConnectors();
        app.MapConnectorAdmin();
    }
}
