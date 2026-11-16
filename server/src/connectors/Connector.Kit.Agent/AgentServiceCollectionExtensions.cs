using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent;

public static class AgentServiceCollectionExtensions
{
    // machine-level (adapters, registry, profile ROOT, politeness gate, scratch root, clock, slots) vs per-connector (identity,
    // token, two clients, profile store, runner, lease loop): a machine singleton used per connector would put one connector's
    // token on another's request, so the per-connector objects are built by hand. Code in `configure` wins over config
    public static IServiceCollection AddConnectorAgent(
        this IServiceCollection services,
        IConfiguration config,
        Action<ConnectorAgentOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);

        var options = new ConnectorAgentOptions();
        Bind(options, config.GetSection(ConnectorAgentOptions.SectionName));
        configure?.Invoke(options);

        // fails at startup: a misconfigured agent that looks healthy and never picks up work is worse than one that refuses to boot
        options.Validate();

        var connections = options.ResolvedConnections();

        services.AddSingleton(options);
        services.TryAddSingleton(TimeProvider.System);

        foreach (var adapter in options.AdapterDescriptors)
        {
            services.Add(adapter);
        }

        // the operator's explore run (#441 L3) rides on every agent image so the digests agree; the queue hands it to a fleet
        // agent only: a household's own machine never leases a job that is not its owner's
        services.AddSingleton<IProviderAdapter>(sp => new Exploring.ExploreAdapter(sp.GetRequiredService<TimeProvider>()));

        services.AddSingleton<IProviderRegistry>(sp => new ProviderRegistry(sp.GetServices<IProviderAdapter>()));
        services.AddSingleton(sp => new AgentStateStore(
            options.StateFilePath, sp.GetRequiredService<ILogger<AgentStateStore>>()));
        services.AddSingleton(sp => new PolitenessGate(sp.GetRequiredService<TimeProvider>()));
        services.AddSingleton(sp => new WorkRoot(options, sp.GetRequiredService<ILogger<WorkRoot>>()));
        services.AddSingleton(_ => new AgentSlots(options.MaxConcurrency));
        services.AddSingleton(sp => new AgentRoster(
            connections.Count,
            sp.GetRequiredService<IHostApplicationLifetime>(),
            sp.GetRequiredService<ILogger<AgentRoster>>()));

        foreach (var connection in connections)
        {
            // created here: the auth handler holds this connector's identity, and one resolved by type would hold the last registered
            var identity = new AgentIdentity();

            // two clients: long polls must hang, keepalives must fail in time to retry inside the lease and liveness window
            // (ConnectorAgentOptions.KeepaliveTimeout). A client, not a deadline token: a client timeout is a TaskCanceledException
            // ControlPlaneClient maps to transient, while our own token would look like the caller stopping, which ends renewal
            AddControlPlaneClient(
                ControlPlaneClient.ClientNameFor(connection.Name), options.ControlPlaneTimeout, connection, identity);
            AddControlPlaneClient(
                ControlPlaneClient.KeepaliveClientNameFor(connection.Name),
                options.KeepaliveTimeout,
                connection,
                identity);

            services.AddSingleton<IHostedService>(sp => Host(sp, options, connection, identity));
        }

        return services;

        void AddControlPlaneClient(
            string name, TimeSpan timeout, ConnectorConnection connection, AgentIdentity identity) =>
            services.AddHttpClient(name, client =>
                {
                    client.BaseAddress = connection.RequireBaseAddress();
                    client.Timeout = timeout;
                })
                .AddHttpMessageHandler(() => new AgentAuthHandler(identity))
                .ConfigurePrimaryHttpMessageHandler(() =>
                {
                    var handler = new HttpClientHandler();

                    // only these clients trust the operator's private CA; the clients that drive real providers never get it
                    if (ControlPlaneTrust.Validator(connection.ControlPlaneCaPath) is { } validate)
                    {
                        handler.ServerCertificateCustomValidationCallback =
                            (request, certificate, chain, errors) => validate(request, certificate, chain, errors);
                    }

                    return handler;
                });
    }

    private static AgentHost Host(
        IServiceProvider sp,
        ConnectorAgentOptions options,
        ConnectorConnection connection,
        AgentIdentity identity)
    {
        var loggers = sp.GetRequiredService<ILoggerFactory>();
        var time = sp.GetRequiredService<TimeProvider>();

        var control = new ControlPlaneClient(
            sp.GetRequiredService<IHttpClientFactory>(),
            loggers.CreateLogger<ControlPlaneClient>(),
            connection.Name);

        // under this connector's own root: a revoke wipes only its browsers, and the heartbeat describes its routable profiles
        var profiles = new ProfileStore(
            connection.ProfileRootUnder(options.ProfileRootDirectory), loggers.CreateLogger<ProfileStore>());

        var runner = new JobRunner(
            sp.GetRequiredService<IProviderRegistry>(),
            control,
            sp.GetRequiredService<PolitenessGate>(),
            profiles,
            identity,
            options,
            loggers,
            time);

        return new AgentHost(
            new AgentConnection(connection, identity, control, profiles, runner),
            options,
            sp.GetRequiredService<AgentStateStore>(),
            sp.GetRequiredService<IProviderRegistry>(),
            sp.GetRequiredService<AgentSlots>(),
            sp.GetRequiredService<WorkRoot>(),
            sp.GetRequiredService<AgentRoster>(),
            loggers.CreateLogger<AgentHost>(),
            time);
    }

    // by hand: the wire spells runtimes browser_once, the CLR BrowserOnce, and the binder would reject the former
    private static void Bind(ConnectorAgentOptions options, IConfigurationSection section)
    {
        if (!section.Exists()) return;

        if (section["ControlPlaneBaseUrl"] is { Length: > 0 } url &&
            Uri.TryCreate(url, UriKind.Absolute, out var parsed))
        {
            options.ControlPlaneBaseUrl = parsed;
        }

        if (section["EnrollmentCode"] is { Length: > 0 } code) options.EnrollmentCode = code;
        if (section["AgentName"] is { Length: > 0 } name) options.AgentName = name;
        if (section["StateFilePath"] is { Length: > 0 } state) options.StateFilePath = state;
        if (section["ControlPlaneCaPath"] is { Length: > 0 } ca) options.ControlPlaneCaPath = ca;
        if (section["ProfileRootDirectory"] is { Length: > 0 } profiles) options.ProfileRootDirectory = profiles;
        if (section["WorkRootDirectory"] is { Length: > 0 } work) options.WorkRootDirectory = work;

        if (int.TryParse(section["MaxConcurrency"], out var concurrency)) options.MaxConcurrency = concurrency;
        if (bool.TryParse(section["Headless"], out var headless)) options.Headless = headless;
        if (TryParseEnum<AgentClass>(section["Class"], out var agentClass)) options.Class = agentClass;

        BindBrowser(options, section);
        BindServed(options, section);
        BindConnections(options, section.GetSection("Connections"));
    }

    private static void BindBrowser(ConnectorAgentOptions options, IConfigurationSection section)
    {
        if (section["BrowserDevice"] is { Length: > 0 } device) options.BrowserDevice = device;
        if (section["BrowserChannel"] is { Length: > 0 } channel) options.BrowserChannel = channel;
        if (section["BrowserLocale"] is { Length: > 0 } locale) options.BrowserLocale = locale;
        if (section["BrowserTimezoneId"] is { Length: > 0 } timezone) options.BrowserTimezoneId = timezone;
    }

    private static void BindServed(ConnectorAgentOptions options, IConfigurationSection section)
    {
        foreach (var provider in section.GetSection("Providers").GetChildren())
        {
            if (provider.Value is { Length: > 0 } id) options.Providers.Add(id);
        }

        foreach (var runtime in section.GetSection("Runtimes").GetChildren())
        {
            if (TryParseEnum<ProviderRuntime>(runtime.Value, out var tier)) options.Runtimes.Add(tier);
        }

        var egress = section.GetSection("Egress");
        if (egress["Country"] is { Length: > 0 } country && egress["Kind"] is { Length: > 0 } kind)
        {
            options.Egress = new EgressRequirement { Country = country, Kind = kind };
        }
    }

    // by hand for the same reason. The environment binding matters (ConnectorAgent__Connections__0__Name): compose configures
    // agents that way. A wholly empty entry is skipped (trailing YAML index); one with something but no control plane
    // is refused by Validate
    private static void BindConnections(ConnectorAgentOptions options, IConfigurationSection section)
    {
        if (!section.Exists()) return;

        foreach (var entry in section.GetChildren())
        {
            var name = entry["Name"];
            var url = entry["ControlPlaneBaseUrl"];
            var code = entry["EnrollmentCode"];
            var ca = entry["ControlPlaneCaPath"];

            if (string.IsNullOrWhiteSpace(name) &&
                string.IsNullOrWhiteSpace(url) &&
                string.IsNullOrWhiteSpace(code) &&
                string.IsNullOrWhiteSpace(ca))
            {
                continue;
            }

            var connection = new ConnectorConnection();

            // the index as the name when none is given, so two unnamed connectors stay two directories and log prefixes
            connection.Name = string.IsNullOrWhiteSpace(name) ? entry.Key : name;

            if (!string.IsNullOrWhiteSpace(url) && Uri.TryCreate(url, UriKind.Absolute, out var parsed))
            {
                connection.ControlPlaneBaseUrl = parsed;
            }

            if (!string.IsNullOrWhiteSpace(code)) connection.EnrollmentCode = code;
            if (!string.IsNullOrWhiteSpace(ca)) connection.ControlPlaneCaPath = ca;

            options.Connections.Add(connection);
        }
    }

    private static bool TryParseEnum<T>(string? value, out T parsed) where T : struct, Enum
    {
        parsed = default;
        if (string.IsNullOrWhiteSpace(value)) return false;

        return Enum.TryParse(value.Replace("_", string.Empty, StringComparison.Ordinal), ignoreCase: true, out parsed);
    }
}
