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

/// both products' APIs are thin shells over this, so no behaviour lives in one Program.cs and is lacking in the other
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

        // the OpenAPI document only outside production; the transformer publishes the normalised records, since a fetch
        // declares JsonArray and the reference would otherwise say nothing about the rows
        if (!options.IsProduction)
        {
            services.AddOpenApi(document => document.AddDocumentTransformer<RecordSchemaTransformer>());
        }

        services.AddDbContext<ConnectorDbContext>(builder => ConnectorDbContext.Configure(builder, options.Database));

        // raw payloads are development-only (connectors are pipes, not stores); withheld here so the catalogue never offers them
        // the operator's explore run (#441 L3): manifest only, so the queue holds its jobs and a fleet agent leases them
        services.AddSingleton(Connector.Kit.Exploring.ExploreProvider.ManifestOnly);

        services.AddSingleton<IProviderRegistry>(sp =>
            new ProviderRegistry(sp.GetServices<IProviderAdapter>(), offerRawPayloads: !options.IsProduction));

        services.AddSingleton<IBundleKeyRing>(_ => BuildKeyRing(options));
        services.AddSingleton(sp => new SealedBundleCodec(
            sp.GetRequiredService<IBundleKeyRing>(), sp.GetRequiredService<TimeProvider>()));

        services.AddSingleton<ConnectorSignals>();

        // singleton: a streamed login's frames and input meet only in process memory; a frame in the database would rest pixels
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
        services.AddScoped<JobArtifactService>();
        services.AddScoped<JobTraceService>();
        services.AddScoped<JobOutcomeService>();
        services.AddScoped<ViewBuilder>();
        services.AddScoped<FetchRunner>();

        services.AddSingleton<ConnectorAuth>();
        services.AddScoped<AgentAuth>();
        services.AddSingleton<ConnectorAuthFilter>();
        services.AddSingleton<AdminScopeFilter>();
        services.AddSingleton<AgentAuthFilter>();
        services.AddSingleton<ConnectorExceptionFilter>();

        // every outbound provider call passes the politeness limiter, registered on the named client, not left to adapters
        services.AddTransient<PolitenessHandler>();
        services.AddTransient(_ => new Connector.Kit.Tracing.TraceHttpHandler(() => Connector.Kit.Tracing.TraceScope.Book));
        services.AddHttpClient(InlineJobRunner.HttpClientName)
            .AddHttpMessageHandler<Connector.Kit.Tracing.TraceHttpHandler>()
            .AddHttpMessageHandler<PolitenessHandler>();

        services.AddSingleton<IInlineJobRunner, InlineJobRunner>();
        // what each party last said about its budget, and the logos a lookup vendors (#414)
        services.AddSingleton<ProviderQuotaService>();
        services.AddMemoryCache();
        services.AddSingleton<LookupService>();
        if (platform.RunInlineJobs) services.AddHostedService<InlineJobPump>();
        if (platform.RunExpiryService) services.AddHostedService<ExpiryService>();

        // tied to the expiry service: both are the "host runs background work" role; a test host turns both off
        // a singleton so the operator's "run it now" reaches the scheduler the timer drives (#441 L1)
        services.AddSingleton<CanaryScheduler>();
        if (platform.RunExpiryService) services.AddHostedService(sp => sp.GetRequiredService<CanaryScheduler>());

        if (options.IsProduction)
        {
            services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(jwt =>
                {
                    jwt.Authority = options.Auth.Authority;
                    jwt.Audience = options.Auth.Audience;
                    jwt.RequireHttpsMetadata = options.Auth.RequireHttpsMetadata;
                    if (options.Auth.MetadataAddress is { Length: > 0 } metadata) jwt.MetadataAddress = metadata;
                    // the claims as the token carries them: the scope check reads "scope"
                    jwt.MapInboundClaims = false;
                });
        }

        // a host adding its own endpoint gets the wire encoding instead of camelCase by accident
        services.ConfigureHttpJsonOptions(json =>
        {
            json.SerializerOptions.PropertyNamingPolicy = ConnectorJson.Options.PropertyNamingPolicy;
            json.SerializerOptions.DefaultIgnoreCondition = ConnectorJson.Options.DefaultIgnoreCondition;
            foreach (var converter in ConnectorJson.Options.Converters) json.SerializerOptions.Converters.Add(converter);
        });

        return services;
    }

    public static IEndpointRouteBuilder MapConnectorApi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        var platform = app.ServiceProvider.GetRequiredService<ConnectorPlatformOptions>();

        var api = app.MapGroup("/v1")
            // the exception filter is outermost so an auth failure comes back as an envelope
            .AddEndpointFilter<ConnectorExceptionFilter>()
            .AddEndpointFilter<ConnectorAuthFilter>();

        // declared on the group: every route fails into the same envelope; only the statuses a caller must branch on
        // WithMetadata because Produces is a RouteHandlerBuilder extension and this is the group
        api.WithMetadata(
            Envelope(StatusCodes.Status400BadRequest),
            Envelope(StatusCodes.Status401Unauthorized),
            Envelope(StatusCodes.Status500InternalServerError));

        // operator routes: a second filter on a nested group, so an admin route is added here and nowhere else
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
        OperatorEndpoints.Map(admin);

        return app;
    }

    private static ProducesResponseTypeMetadata Envelope(int status) =>
        new(status, typeof(ConnectorErrorEnvelope), ["application/json"]);

    /// development only, absent in production rather than authenticated: production /v1/* needs a client certificate
    /// and an M2M token no browser can present; in dev it opens no door that is not already open (localhost-only stack)
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

    /// its own path and identity class: a per-agent token reaches this and nothing else
    public static IEndpointRouteBuilder MapAgentApi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        AgentApiEndpoints.Map(app);
        return app;
    }

    public static WebApplication UseConnectorPlatform(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        DatabaseStartup.WaitForServerAsync(db.Database, app.Logger, TimeSpan.FromMinutes(5)).GetAwaiter().GetResult();
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

        // re-armed on every start so a pooled agent with a wiped state file comes back
        if (options.FleetEnrollmentCode is { Length: > 0 } fleetCode)
        {
            scope.ServiceProvider.GetRequiredService<AgentAuth>()
                .SeedStandingEnrollmentAsync(fleetCode, ConnectorOptions.FleetSubject, "fleet", CancellationToken.None)
                .GetAwaiter().GetResult();
        }

        // hosted private slots (#420 A2): the same standing-code rule, under a subject that serves nobody until bound
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

    /// a production service without real bundle keys would seal credentials under a key that dies with the process
    /// most checks are production-only; the heartbeat coupling is checked in every mode
    internal static void Validate(ConnectorOptions options)
    {
        var problems = new List<string>();

        // before the production gate: a self-contradicting config is as broken on a laptop as in production
        // a beat interval whose third beat lands past OfflineAfterSeconds (90) gets healthy agents refused work at random
        // local is where the number gets changed (quieting a dev log), so skipping the check there would hide it
        if (options.Timeouts.HeartbeatSeconds * 3 > AgentLiveness.OfflineAfterSeconds)
        {
            problems.Add(
                $"Connector:Timeouts:HeartbeatSeconds is {options.Timeouts.HeartbeatSeconds}, so three beats take "
                + $"{options.Timeouts.HeartbeatSeconds * 3}s - longer than the "
                + $"{AgentLiveness.OfflineAfterSeconds}s AgentLiveness.OfflineAfterSeconds allows an agent to be "
                + "silent; every agent would be refused work for part of every cycle while running normally");
        }

        // a contradiction too: a private slot enrolled with the fleet code is the fleet and serves everybody
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

        // a fixed, reusable, never-expiring code is a password, and this one sits in a checked-in compose file
        if (!string.IsNullOrWhiteSpace(options.DevEnrollmentCode))
        {
            problems.Add("Connector:DevEnrollmentCode must not be set in production");
        }

        Refuse(problems);
    }

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

        // development only; a restart invalidates every bundle, fine locally and unacceptable deployed
        return BundleKeyRing.Ephemeral();
    }
}
