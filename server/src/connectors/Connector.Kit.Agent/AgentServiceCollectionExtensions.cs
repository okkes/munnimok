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

/// <summary>
/// The whole composition surface of the data plane. Every product's agent is a
/// <c>Program.cs</c> that calls this and lists its adapters.
/// </summary>
public static class AgentServiceCollectionExtensions
{
    /// <summary>
    /// Registers the agent: the adapter registry, the politeness limiter and
    /// the browser budget once for the machine, then a lease loop, an identity
    /// and a control-plane client for each connector it serves.
    /// </summary>
    /// <param name="config">
    /// Bound from the <c>ConnectorAgent</c> section. Anything in
    /// <paramref name="configure"/> wins, so a host can put the endpoint in
    /// configuration and its adapters in code.
    /// </param>
    /// <remarks>
    /// <b>The split between the two halves is the whole design.</b> The
    /// adapters, the provider registry, the profile ROOT, the politeness gate,
    /// the scratch root, the clock and the job slots are properties of the
    /// COMPUTER, and there is one of each however many connectors are
    /// configured. The identity, the token, the two HTTP clients, the profile
    /// store, the job runner and the lease loop are properties of one
    /// CONNECTOR, and there is a set of them per connection. Anything
    /// registered as a singleton on the left of that line and used on the right
    /// is a bug the compiler cannot see - one connector's bearer token on
    /// another connector's request - which is why the per-connector objects are
    /// constructed here by hand rather than resolved by type.
    /// </remarks>
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

        // Fails at startup rather than on the first lease: a misconfigured
        // agent that looks healthy and never picks up work is worse than one
        // that refuses to boot.
        options.Validate();

        var connections = options.ResolvedConnections();

        services.AddSingleton(options);
        services.TryAddSingleton(TimeProvider.System);

        foreach (var adapter in options.AdapterDescriptors)
        {
            services.Add(adapter);
        }

        // The operator's explore run (#441 L3) rides on every agent image: the
        // control plane carries the same manifest, so the agent-served digests
        // agree, and the queue hands an explore job to a fleet agent only -
        // a household's own machine never leases a job that is not its owner's.
        services.AddSingleton<IProviderAdapter>(sp => new Exploring.ExploreAdapter(sp.GetRequiredService<TimeProvider>()));

        // ── the machine ──────────────────────────────────────────────────
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

        // ── and one of these per connector ───────────────────────────────
        foreach (var connection in connections)
        {
            // Created HERE rather than inside the host factory because the two
            // HTTP clients need it now: the auth handler holds this
            // connector's identity and nobody else's, and a handler resolved
            // by type from the container would hold whichever identity was
            // registered last.
            var identity = new AgentIdentity();

            // TWO CLIENTS ONTO ONE CONTROL PLANE, because a timeout is a
            // property of the client and these calls need two of them. The
            // long polls must be allowed to hang - that is what a long poll is
            // - and the two keepalives must fail in time to be retried inside
            // the lease and the liveness window they are holding open. One
            // client meant the short calls inherited the long polls' seventy
            // seconds and were given up on after the job had been requeued and
            // the agent marked offline; see
            // ConnectorAgentOptions.KeepaliveTimeout for the arithmetic.
            //
            // A second CLIENT rather than a deadline token at the call site:
            // the client's own timeout arrives as a TaskCanceledException with
            // nobody's token cancelled, which is precisely the case
            // ControlPlaneClient translates into a transient failure. A token
            // of ours would arrive cancelled and be indistinguishable from the
            // caller asking to stop - the one reading that ends renewal for
            // good.
            //
            // Both are per CONNECTOR as well as per purpose, and now carry its
            // name: a client holds one connector's base address, one
            // connector's certificate authority and one connector's token.
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

                    // ONLY THESE CLIENTS. An agent drives real providers over
                    // the public web with other clients entirely, and none of
                    // them gets the operator's private authority.
                    if (ControlPlaneTrust.Validator(connection.ControlPlaneCaPath) is { } validate)
                    {
                        handler.ServerCertificateCustomValidationCallback =
                            (request, certificate, chain, errors) => validate(request, certificate, chain, errors);
                    }

                    return handler;
                });
    }

    /// <summary>
    /// One connector's lease loop, with its own identity, client, profiles and
    /// runner, over the machine's adapters, gate, slots and clock.
    /// </summary>
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

        // Under this connector's own root, so that a revoke here wipes this
        // connector's browsers and leaves the others signed in - and so that
        // the heartbeat this connector sends describes the profiles it can
        // actually be routed to.
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

    /// <summary>
    /// Bound by hand rather than through the configuration binder: the wire
    /// spells runtimes <c>browser_once</c> and the CLR spells them
    /// <c>BrowserOnce</c>, and the binder would simply reject the former.
    /// </summary>
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

    /// <summary>The browser the agent presents.</summary>
    private static void BindBrowser(ConnectorAgentOptions options, IConfigurationSection section)
    {
        if (section["BrowserDevice"] is { Length: > 0 } device) options.BrowserDevice = device;
        if (section["BrowserChannel"] is { Length: > 0 } channel) options.BrowserChannel = channel;
        if (section["BrowserLocale"] is { Length: > 0 } locale) options.BrowserLocale = locale;
        if (section["BrowserTimezoneId"] is { Length: > 0 } timezone) options.BrowserTimezoneId = timezone;
    }

    /// <summary>What the agent serves and from where: providers, tiers, egress.</summary>
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

    /// <summary>
    /// The connector list, by hand for the same reason as the rest of this
    /// file.
    /// </summary>
    /// <remarks>
    /// The binding that matters is the ENVIRONMENT's -
    /// <c>ConnectorAgent__Connections__0__Name</c>, which the environment
    /// provider hands over as <c>ConnectorAgent:Connections:0:Name</c> - because
    /// that is how a compose file configures a container and how every agent on
    /// this platform is actually configured.
    /// <para>
    /// An entry with nothing in it at all is skipped rather than kept as an
    /// empty connection: the list is written by hand in a YAML file, and a
    /// trailing index nobody filled in should not be a connector this agent
    /// refuses to boot over. An entry with SOMETHING in it and no control plane
    /// is a different matter, and <see cref="ConnectorAgentOptions.Validate"/>
    /// refuses that - it is a connector somebody meant to configure.
    /// </para>
    /// </remarks>
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

            // The index as the name when none is given, so that two unnamed
            // connectors are still two directories and two log prefixes
            // instead of one of each. Naming them is much better and the
            // documentation says so; being unnamed must not silently merge
            // them.
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

    /// <summary>Accepts both the wire's <c>snake_case</c> and the CLR's <c>PascalCase</c>.</summary>
    private static bool TryParseEnum<T>(string? value, out T parsed) where T : struct, Enum
    {
        parsed = default;
        if (string.IsNullOrWhiteSpace(value)) return false;

        return Enum.TryParse(value.Replace("_", string.Empty, StringComparison.Ordinal), ignoreCase: true, out parsed);
    }
}
