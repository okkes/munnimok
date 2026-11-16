using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Munni.Api.Connectors;

public enum ConnectorPresence
{
    Absent,

    // the machine credential the platform's Logto module writes back after the first bootstrap is missing:
    // off until a restart finds it
    WaitingForCredential,

    Enabled,
}

// follows BankingSetup.Register: an unconfigured connector is absent, never a stand-in; a setting that cannot be right
// refuses to start with its name
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
        services.AddScoped<ConnectorSupersession>();
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

    public static void Map(WebApplication app, ConnectorPresence presence)
    {
        switch (presence)
        {
            case ConnectorPresence.Enabled:
                app.MapConnectors();
                app.MapConnectorLab();
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
