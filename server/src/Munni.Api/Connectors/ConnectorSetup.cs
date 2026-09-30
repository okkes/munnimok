using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Munni.Api.Connectors;

/// <summary>Whether this environment relays to a control plane, and if not yet, why.</summary>
public enum ConnectorPresence
{
    /// <summary>No <c>Connectors:BaseUrl</c>: this environment runs no connectors.</summary>
    Absent,

    /// <summary>
    /// A control plane is named but the machine credential the platform's
    /// Logto module writes back after the first bootstrap is not there yet;
    /// the relay stays off until the next start finds it.
    /// </summary>
    WaitingForCredential,

    Enabled,
}

/// <summary>
/// Registers the relay when — and only when — this environment names a
/// control plane and holds a credential for it. Follows
/// <c>BankingSetup.Register</c>: an unconfigured connector is simply absent,
/// never a silent stand-in; a configured one with a setting that cannot be
/// right refuses to start with the setting's name.
/// </summary>
public static class ConnectorSetup
{
    public static ConnectorPresence Register(IServiceCollection services, IConfiguration config)
    {
        var options = config.GetSection(ConnectorOptions.SectionName).Get<ConnectorOptions>() ?? new ConnectorOptions();
        if (!options.Configured) return ConnectorPresence.Absent;
        options.Require();
        if (!options.HasCredential) return ConnectorPresence.WaitingForCredential;

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
        services.AddScoped<ConnectorDisconnector>();
        // the scheduler for household-agent custody (§5.5): the one place a
        // sync starts without a device holding the bundle
        services.AddSingleton<ConnectorScheduleService>();
        services.AddHostedService(sp => sp.GetRequiredService<ConnectorScheduleService>());
        services.AddHttpClient<ConnectorClient>(client =>
        {
            client.BaseAddress = options.BaseAddress();
            client.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
        });
        return ConnectorPresence.Enabled;
    }

    /// <summary>Maps the relay and its operator routes when the environment runs connectors; says so when it is waiting; nothing otherwise.</summary>
    public static void Map(WebApplication app, ConnectorPresence presence)
    {
        switch (presence)
        {
            case ConnectorPresence.Enabled:
                app.MapConnectors();
                app.MapConnectorAdmin();
                break;
            case ConnectorPresence.WaitingForCredential:
                app.Logger.LogWarning(
                    "Connectors:BaseUrl is set but no credential for the control plane is: the relay stays off until Connectors:M2mAppId and Connectors:M2mAppSecret are written back by the platform bootstrap (or Connectors:DevKey is set locally)");
                break;
            default:
                break;
        }
    }
}
