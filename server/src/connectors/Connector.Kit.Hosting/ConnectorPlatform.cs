using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Live;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Hosting.Tickets;
using Connector.Kit.Security;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Scalar.AspNetCore;

namespace Connector.Kit.Hosting;

/// <summary>
/// The whole control plane, as four calls.
///
/// Both products' APIs are meant to be thin shells over this - register
/// adapters, map the routes - so that everything a control plane does exists
/// once. A behaviour that lived in one product's <c>Program.cs</c> would be a
/// behaviour the other one silently lacks.
/// </summary>
public static class ConnectorPlatform
{
    public static IServiceCollection AddConnectorPlatform(
        this IServiceCollection services,
        IConfiguration config,
        Action<ConnectorPlatformOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);

        var platform = new ConnectorPlatformOptions();
        configure?.Invoke(platform);
        platform.Apply(services);
        services.AddSingleton(platform);

        var options = config.GetSection(ConnectorOptions.SectionName).Get<ConnectorOptions>() ?? new ConnectorOptions();
        Validate(options);
        services.AddSingleton(Options.Create(options));

        services.TryAddDefaults();

        // The OpenAPI document, and only outside production. Registering the
        // generator is harmless there too, but keeping the pair together means
        // one rule to read rather than two halves to line up.
        //
        // The transformer publishes the normalised records. Minimal APIs
        // describe a response from the handler's declared return type, and a
        // fetch declares JsonArray - so without it the reference names every
        // envelope and says nothing about the rows inside, which is the half a
        // consumer is actually writing code against.
        if (!options.IsProduction)
        {
            services.AddOpenApi(document => document.AddDocumentTransformer<RecordSchemaTransformer>());
        }

        services.AddDbContext<ConnectorDbContext>(builder => ConnectorDbContext.Configure(builder, options.Database));

        // Raw payloads are a development affordance and the README says so:
        // "connectors are pipes, not stores... raw provider payloads are off
        // in production". Withholding it here rather than at the request means
        // the catalogue never advertises what production would refuse.
        services.AddSingleton<IProviderRegistry>(sp =>
            new ProviderRegistry(sp.GetServices<IProviderAdapter>(), offerRawPayloads: !options.IsProduction));

        services.AddSingleton<IBundleKeyRing>(_ => BuildKeyRing(options));
        services.AddSingleton(sp => new SealedBundleCodec(
            sp.GetRequiredService<IBundleKeyRing>(), sp.GetRequiredService<TimeProvider>()));

        services.AddSingleton<ConnectorSignals>();

        // A singleton because a streamed login's frames and its input have to
        // meet in one place, and process memory is the only place either may
        // be: a frame written to the database would put the provider's
        // authenticated pixels at rest in the control plane, which is the
        // custody problem streaming exists to remove.
        services.AddSingleton(sp => new LiveChannel(sp.GetRequiredService<TimeProvider>()));
        services.AddSingleton<ITicketStore>(sp => new InMemoryTicketStore(sp.GetRequiredService<TimeProvider>()));
        services.AddSingleton<IIdempotencyStore>(sp => new InMemoryIdempotencyStore(sp.GetRequiredService<TimeProvider>()));

        services.AddScoped<ILeasedJobQueue, EfLeasedJobQueue>();
        services.AddScoped<SessionService>();
        services.AddScoped<ChallengeService>();
        services.AddScoped<ResultService>();
        services.AddScoped<ProviderStatusService>();
        services.AddScoped<SyncInterval>();
        services.AddScoped<CanaryService>();
        services.AddScoped<JobOutcomeService>();
        services.AddScoped<ViewBuilder>();
        services.AddScoped<FetchRunner>();

        services.AddSingleton<ConnectorAuth>();
        services.AddScoped<AgentAuth>();
        services.AddSingleton<ConnectorAuthFilter>();
        services.AddSingleton<AdminScopeFilter>();
        services.AddSingleton<AgentAuthFilter>();
        services.AddSingleton<ConnectorExceptionFilter>();

        // Every outbound provider call goes through the politeness limiter.
        // Registering it on the named client rather than leaving it to
        // adapters is what makes "human-plausible cadence, never a firehose"
        // a property of the platform.
        services.AddTransient<PolitenessHandler>();
        services.AddHttpClient(InlineJobRunner.HttpClientName)
            .AddHttpMessageHandler<PolitenessHandler>();

        services.AddSingleton<IInlineJobRunner, InlineJobRunner>();
        // what each party last said about its budget, and the logos a lookup vendors (#414)
        services.AddSingleton<ProviderQuotaService>();
        services.AddMemoryCache();
        services.AddSingleton<LookupService>();
        if (platform.RunInlineJobs) services.AddHostedService<InlineJobPump>();
        if (platform.RunExpiryService) services.AddHostedService<ExpiryService>();

        // Tied to the expiry service rather than given its own switch: both are
        // the "this host runs the background work" role, and a deployment that
        // wanted one without the other has not been asked for. A test host
        // turns both off and drives the sweep by hand.
        if (platform.RunExpiryService) services.AddHostedService<CanaryScheduler>();

        if (options.IsProduction)
        {
            services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(jwt =>
                {
                    jwt.Authority = options.Auth.Authority;
                    jwt.Audience = options.Auth.Audience;
                    jwt.RequireHttpsMetadata = options.Auth.RequireHttpsMetadata;
                    if (options.Auth.MetadataAddress is { Length: > 0 } metadata) jwt.MetadataAddress = metadata;
                    // The claims as the token carries them: the scope check
                    // reads "scope", and the legacy inbound map would rename
                    // others for nobody's benefit.
                    jwt.MapInboundClaims = false;
                });
        }

        // Responses written through ConnectorResults already carry the wire
        // encoding; configuring it here as well means a host that adds its own
        // endpoint gets the same one instead of camelCase by accident.
        services.ConfigureHttpJsonOptions(json =>
        {
            json.SerializerOptions.PropertyNamingPolicy = ConnectorJson.Options.PropertyNamingPolicy;
            json.SerializerOptions.DefaultIgnoreCondition = ConnectorJson.Options.DefaultIgnoreCondition;
            foreach (var converter in ConnectorJson.Options.Converters) json.SerializerOptions.Converters.Add(converter);
        });

        return services;
    }

    /// <summary>
    /// The public API: the catalogue, sessions, resources, jobs and agents,
    /// all provider-namespaced and all served by one generic handler per
    /// shape. Adding a provider never touches this method.
    /// </summary>
    public static IEndpointRouteBuilder MapConnectorApi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        var platform = app.ServiceProvider.GetRequiredService<ConnectorPlatformOptions>();

        var api = app.MapGroup("/v1")
            // Order matters: the exception filter is outermost so an auth
            // failure comes back as an envelope like everything else.
            .AddEndpointFilter<ConnectorExceptionFilter>()
            .AddEndpointFilter<ConnectorAuthFilter>();

        // Declared on the group because the filter above is on the group: every
        // route under it fails into the same envelope, so documenting it here
        // says once what would otherwise be twenty-four identical lines nobody
        // keeps in step. The statuses are the ones a caller must actually
        // branch on - the full code-to-status map is the error catalogue's,
        // and reproducing it per route would describe the taxonomy rather
        // than the route.
        //
        // WithMetadata rather than Produces because Produces is a
        // RouteHandlerBuilder extension and this is the group; the metadata it
        // adds is this same type either way.
        api.WithMetadata(
            Envelope(StatusCodes.Status400BadRequest),
            Envelope(StatusCodes.Status401Unauthorized),
            Envelope(StatusCodes.Status500InternalServerError));

        // The operator's routes: the kill switch, canaries, the whole fleet.
        // A second filter on a nested group, so that adding an admin route
        // means adding it here and nothing else.
        var admin = api.MapGroup("/admin")
            .AddEndpointFilter<AdminScopeFilter>();

        admin.WithMetadata(Envelope(StatusCodes.Status403Forbidden));

        CatalogEndpoints.Map(api, admin, app, platform);
        LookupEndpoints.Map(api, admin);
        LoginEndpoints.Map(api, platform);
        LiveEndpoints.MapConsumer(api);
        ResourceEndpoints.Map(api);
        JobEndpoints.Map(api);
        AgentAdminEndpoints.Map(api, admin);
        PrivateAgentEndpoints.Map(api, admin);

        return app;
    }

    /// <summary>The failure shape <see cref="ConnectorExceptionFilter"/> guarantees, at one status.</summary>
    private static ProducesResponseTypeMetadata Envelope(int status) =>
        new(status, typeof(ConnectorErrorEnvelope), ["application/json"]);

    /// <summary>
    /// The API reference: the OpenAPI document at <c>/openapi/v1.json</c> and
    /// Scalar over it at <c>/scalar</c>. Development only, and silently absent
    /// in production.
    ///
    /// Absent rather than authenticated, because there is no credential a
    /// browser could sensibly present. Production <c>/v1/*</c> demands an
    /// allowlisted client certificate AND an audience-checked M2M token; a
    /// reference page that could be fetched from a browser would be describing
    /// an API that browser cannot call, and the login form it would need to
    /// become useful is a second way in to a service whose whole design is that
    /// there is one.
    ///
    /// In development the same routes need nothing: dev mode accepts a shared
    /// secret, and with none configured - which is what the local compose file
    /// does - it accepts every caller. So this opens no door that is not
    /// already open, on a stack that publishes to localhost only.
    /// </summary>
    public static WebApplication MapConnectorReference(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        if (app.Services.GetRequiredService<IOptions<ConnectorOptions>>().Value.IsProduction) return app;

        app.MapOpenApi();
        app.MapScalarApiReference(options => options
            .WithTitle("Connector API")
            .WithTheme(ScalarTheme.BluePlanet));

        return app;
    }

    /// <summary>
    /// The agent protocol, on its own path and its own identity class. A
    /// per-agent token reaches this and nothing else.
    /// </summary>
    public static IEndpointRouteBuilder MapAgentApi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        AgentApiEndpoints.Map(app);
        return app;
    }

    /// <summary>
    /// Brings the schema up and gives every registered provider a health row.
    /// Called once at start-up, before the first request.
    /// </summary>
    public static WebApplication UseConnectorPlatform(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        db.EnsureCreatedOrMigrateAsync().GetAwaiter().GetResult();

        var statuses = scope.ServiceProvider.GetRequiredService<ProviderStatusService>();
        statuses.SeedAsync(CancellationToken.None).GetAwaiter().GetResult();

        // Development only, and Validate has already refused it anywhere else.
        var options = scope.ServiceProvider.GetRequiredService<IOptions<ConnectorOptions>>().Value;
        if (!options.IsProduction && options.DevEnrollmentCode is { Length: > 0 } devCode)
        {
            scope.ServiceProvider.GetRequiredService<AgentAuth>()
                .SeedDevEnrollmentAsync(devCode, CancellationToken.None).GetAwaiter().GetResult();
        }

        // The operator's fleet, anywhere: the platform's own secret, re-armed
        // on every start so a pooled agent with a wiped state file comes back.
        if (options.FleetEnrollmentCode is { Length: > 0 } fleetCode)
        {
            scope.ServiceProvider.GetRequiredService<AgentAuth>()
                .SeedStandingEnrollmentAsync(fleetCode, ConnectorOptions.FleetSubject, "fleet", CancellationToken.None)
                .GetAwaiter().GetResult();
        }

        // Hosted private slots (#420 A2): the same standing-code rule, under
        // a subject that serves nobody until the operator binds it.
        if (options.PrivateEnrollmentCode is { Length: > 0 } privateCode)
        {
            scope.ServiceProvider.GetRequiredService<AgentAuth>()
                .SeedStandingEnrollmentAsync(privateCode, ConnectorOptions.PrivateSlotSubject, "private slot", CancellationToken.None)
                .GetAwaiter().GetResult();
        }

        // Touching the registry here rather than lazily means a manifest that
        // lies fails the deploy instead of the first user.
        _ = scope.ServiceProvider.GetRequiredService<IProviderRegistry>().CatalogDigest;

        return app;
    }

    private static void TryAddDefaults(this IServiceCollection services)
    {
        if (services.All(d => d.ServiceType != typeof(TimeProvider)))
        {
            services.AddSingleton(TimeProvider.System);
        }

        services.AddLogging();
        services.AddRouting();
    }

    /// <summary>
    /// The start-up refusals.
    ///
    /// A production service that boots without real bundle keys would seal
    /// every user's credentials under a key that dies with the process, and
    /// would look completely healthy doing it. Refusing here is the only
    /// place that failure is cheap.
    ///
    /// Most of what follows is about production, because most of what can be
    /// missing is a secret or a piece of infrastructure a developer's machine
    /// legitimately does not have. The heartbeat coupling is the exception and
    /// is checked in every mode - see the comment on it.
    /// </summary>
    internal static void Validate(ConnectorOptions options)
    {
        var problems = new List<string>();

        // BEFORE the production gate, and deliberately so.
        //
        // Every other refusal here describes a deployment that is missing
        // something a local run is meant to be missing, which is why they sit
        // behind IsProduction. This one describes a configuration that
        // contradicts itself, and a contradiction is exactly as broken on a
        // laptop as it is in production: AgentLiveness.OfflineAfterSeconds is
        // a constant ninety seconds and is now a hard REFUSAL rather than a
        // label on a listing, so an interval whose third beat lands outside
        // that window means every agent in the fleet is judged offline for
        // part of every cycle while running perfectly - logins refused with
        // agent_unavailable, fetches refused the same way, intermittently and
        // for no reason the logs explain.
        //
        // And local is where this number would be changed. Somebody slowing
        // the beat down to quieten a dev log would get a stack that refuses
        // work at random, diagnose it as a flaky agent, and ship the value;
        // skipping the check outside production would hide it in the one mode
        // where it is cheapest to find.
        if (options.Timeouts.HeartbeatSeconds * 3 > AgentLiveness.OfflineAfterSeconds)
        {
            problems.Add(
                $"Connector:Timeouts:HeartbeatSeconds is {options.Timeouts.HeartbeatSeconds}, so three beats take "
                + $"{options.Timeouts.HeartbeatSeconds * 3}s - longer than the "
                + $"{AgentLiveness.OfflineAfterSeconds}s AgentLiveness.OfflineAfterSeconds allows an agent to be "
                + "silent; every agent would be refused work for part of every cycle while running normally");
        }

        // A contradiction, so before the production gate for the same reason
        // as the heartbeat: a private slot enrolled with the fleet's code IS
        // the fleet, and serves everybody while claiming to serve one person.
        if (!string.IsNullOrWhiteSpace(options.PrivateEnrollmentCode)
            && string.Equals(options.PrivateEnrollmentCode, options.FleetEnrollmentCode, StringComparison.Ordinal))
        {
            problems.Add(
                "Connector:PrivateEnrollmentCode equals Connector:FleetEnrollmentCode; a private slot must serve nobody "
                + "until it is bound, and the fleet code enrolls a machine that serves everybody");
        }

        if (!options.IsProduction)
        {
            Refuse(problems);
            return;
        }

        if (!options.Bundle.HasKeys)
        {
            problems.Add("Connector:Bundle:CurrentKid and Connector:Bundle:Keys are required in production");
        }

        if (string.IsNullOrWhiteSpace(options.Auth.Authority))
        {
            problems.Add("Connector:Auth:Authority is required in production");
        }

        if (string.IsNullOrWhiteSpace(options.Auth.Audience))
        {
            problems.Add("Connector:Auth:Audience is required in production");
        }

        if (string.IsNullOrWhiteSpace(options.EnrollmentHmacKey))
        {
            problems.Add("Connector:EnrollmentHmacKey is required in production");
        }

        if (options.Database.Provider != ConnectorDatabaseProvider.Postgres)
        {
            problems.Add("Connector:Database:Provider must be 'postgres' in production");
        }

        // A fixed, reusable, never-expiring enrollment code is a password, and
        // the one this option exists for is written in a compose file in the
        // repository. Anything holding it could enroll an agent that leases
        // real jobs and receives real credentials.
        if (!string.IsNullOrWhiteSpace(options.DevEnrollmentCode))
        {
            problems.Add("Connector:DevEnrollmentCode must not be set in production");
        }

        Refuse(problems);
    }

    /// <summary>
    /// The one refusal message, raised from the two places <see cref="Validate"/>
    /// can finish: after the mode-independent checks when this is not a
    /// production host, and after all of them when it is.
    /// </summary>
    private static void Refuse(List<string> problems)
    {
        if (problems.Count == 0) return;

        throw new InvalidOperationException(
            "the connector platform refuses to start:" + Environment.NewLine + "- " +
            string.Join(Environment.NewLine + "- ", problems));
    }

    private static BundleKeyRing BuildKeyRing(ConnectorOptions options)
    {
        if (options.Bundle.HasKeys)
        {
            return BundleKeyRing.FromBase64(options.Bundle.CurrentKid!, options.Bundle.Keys.AsReadOnly());
        }

        // Development only, and unreachable in production - Validate has
        // already refused to start. A restart invalidates every bundle, which
        // is the correct local behaviour and an unacceptable deployed one.
        return BundleKeyRing.Ephemeral();
    }
}
