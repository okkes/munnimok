using System.Threading.RateLimiting;
using Sentry.AspNetCore;
using FluentValidation;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Scalar.AspNetCore;
using Munni.Api;
using Munni.Api.Accounts;
using Munni.Api.Auth;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Admin;
using Munni.Api.ImportWatch;
using Munni.Api.Investments;
using Munni.Api.Logos;
using Munni.Api.Rates;
using Munni.Api.Push;
using Munni.Api.Shopping;
using Munni.Api.Social;
using Munni.Api.Splits;
using Munni.Api.Sync;

var builder = WebApplication.CreateBuilder(args);

// GlitchTip: every unhandled exception + explicit CaptureException calls.
// Sentry__Dsn env feeds Sentry:Dsn; an empty DSN (local/dev) disables the
// SDK entirely — the compose file was already passing the DSN, but the
// SDK was never wired, so the API was invisible while prod broke.
builder.WebHost.UseSentry((SentryAspNetCoreOptions options) =>
{
    // explicit empty string = SDK disabled (unset would throw at boot)
    options.Dsn = builder.Configuration["Sentry:Dsn"] ?? string.Empty;
    options.SendDefaultPii = false;
    // performance tracing (user 2026-10-09, docs/observability.md): the
    // sampled requests become transactions named by their route template
    // (GET /sync/{spaceId}/push), with their EF queries and outgoing calls
    // as spans — Sentry__TracesSampleRate from the environment's
    // tracing.sampleRate (0..1, a fifth unless it says otherwise, 0 = errors
    // only); health probes and the SSE stream never count, and a trace the
    // web app started keeps its decision
    var tracesSampleRate = SentryNoise.TracesSampleRate(builder.Configuration["Sentry:TracesSampleRate"]);
    options.TracesSampler = context => SentryNoise.SampleTrace(context.TransactionContext, tracesSampleRate);
    // our trace headers travel only to the connector control plane, which
    // continues them; Logto, the aggregators, logo.dev, FCM, the OCR and
    // every other party the api calls see no sentry-trace/baggage header
    options.TracePropagationTargets.Clear();
    if (builder.Configuration["Connectors:BaseUrl"] is { Length: > 0 } relay) options.TracePropagationTargets.Add(relay);
    // handled races are not incidents: parallel first requests DELIBERATELY
    // race their inserts (Users / UserDevices JIT-provision, attach links)
    // and the losers adopt the winner. EF still logs the failed command at
    // Error level and the SDK forwarded every one as an event — pure noise
    // that buried real failures (GlitchTip issues 66–74).
    options.SetBeforeSend((sentryEvent, _) => SentryNoise.IsHandledRace(sentryEvent) ? null : sentryEvent);
    // the SDK's failed-HTTP-request handler shipped every upstream 5xx
    // (GoCardless had a 502 hour → four events, GlitchTip 75–78) even
    // though the fetch loop handles them and retries next cycle. Real
    // failures still surface: unhandled exceptions and LogError paths.
    options.CaptureFailedRequests = false;
});

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Db")));

builder.Services.AddMemoryCache();
// request-body validators (Validation/Validators.cs) — UI input is never trusted
builder.Services.AddValidatorsFromAssemblyContaining<Program>(ServiceLifetime.Singleton);
// SSE fan-out for near-real-time sync
builder.Services.AddSingleton<SpaceEventBroadcaster>();
// the account's full cleanup, party-side consents first (its optional services resolve to null where absent)
builder.Services.AddScoped<Munni.Api.Social.AccountDeletion>();

// OpenAPI document + Scalar reference UI at /scalar
builder.Services.AddOpenApi();

// push transports (VAPID browsers + FCM native shells), routed per kind
var pushCaps = PushSetup.Register(builder.Services, builder.Configuration);

// the connector relay (#367): present only when this environment names
// its control plane and holds a credential for it; a setting that cannot
// be right refuses to start, a credential not written back yet is a stage
var connectors = ConnectorSetup.Register(builder.Services, builder.Configuration);
var connectorsEnabled = connectors == ConnectorPresence.Enabled;

// watch-folder importer (user request): CAMT exports dropped into the
// mounted folder ingest as raw feed rows for the configured owner —
// the service exits immediately when ImportWatch:* is unconfigured
builder.Services.AddHostedService<WatchFolderService>();

// Logto Management API (account deletion, the admin portal's invitations —
// user 2026-10-07: invitation-only sign-up): one minting path with a cached
// token; activates with Logto:M2m* config, and the routes say so when absent
builder.Services.AddHttpClient(LogtoManagement.ClientName, client => client.Timeout = TimeSpan.FromSeconds(10));
builder.Services.TryAddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ILogtoManagement, LogtoManagement>();
builder.Services.AddHttpClient("geo", client => client.Timeout = TimeSpan.FromSeconds(4));

// receipt OCR via the Tesseract sidecar — enabled when the container is configured
var ocrEnabled = !string.IsNullOrEmpty(builder.Configuration["Ocr:BaseUrl"]);
if (ocrEnabled)
{
    builder.Services.AddHttpClient(OcrEndpoints.HttpClientName, client =>
    {
        client.BaseAddress = new Uri(builder.Configuration["Ocr:BaseUrl"]!);
        client.Timeout = TimeSpan.FromSeconds(30);
    });
}

// delayed quotes for the portfolio: free vendors, no secrets, always on
builder.Services.AddHttpClient(QuoteEndpoints.YahooClientName, client =>
{
    client.BaseAddress = new Uri("https://query1.finance.yahoo.com"); // NOSONAR(S1075) vendor API base
    // Yahoo throttles default HttpClient agents
    client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) munni/1.0");
    client.Timeout = TimeSpan.FromSeconds(8);
});
builder.Services.AddHttpClient(QuoteEndpoints.CoinGeckoClientName, client =>
{
    client.BaseAddress = new Uri("https://api.coingecko.com"); // NOSONAR(S1075) vendor API base
    client.Timeout = TimeSpan.FromSeconds(8);
});

// ECB reference rates for display-currency conversion — free, no key
builder.Services.AddHttpClient(RatesEndpoints.EcbClientName, client =>
{
    client.BaseAddress = new Uri("https://www.ecb.europa.eu"); // NOSONAR(S1075) vendor API base
    // the full-history file is a few MB — allow it time on slow links
    client.Timeout = TimeSpan.FromSeconds(30);
});

// brand-logo search (logo.dev) — enabled when both keys are configured
var logosEnabled = !string.IsNullOrEmpty(builder.Configuration["Logos:SecretKey"])
                   && !string.IsNullOrEmpty(builder.Configuration["Logos:PublicToken"]);
if (logosEnabled)
{
    builder.Services.AddHttpClient(LogoEndpoints.HttpClientName, client =>
    {
        client.BaseAddress = new Uri("https://api.logo.dev/"); // NOSONAR(S1075) vendor API base
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", builder.Configuration["Logos:SecretKey"]);
        client.Timeout = TimeSpan.FromSeconds(5);
    });
}

if (builder.Configuration.GetValue<bool>("Auth:TestMode"))
{
    builder.Services
        .AddAuthentication(TestAuthHandler.SchemeName)
        .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, null);
}
else
{
    // Logto OIDC bearer (production: https://logto.<domain>/oidc)
    builder.Services
        .AddAuthentication("Bearer")
        .AddJwtBearer("Bearer", options =>
        {
            // keep original OIDC claim names — otherwise "sub" is renamed to
            // the legacy ClaimTypes.NameIdentifier and user resolution fails
            options.MapInboundClaims = false;
            options.Authority = builder.Configuration["Auth:Authority"];
            options.TokenValidationParameters.ValidAudience = builder.Configuration["Auth:Audience"];
            // local docker: browser sees localhost:3001 (issuer) but this
            // container must fetch metadata via the compose network
            var metadata = builder.Configuration["Auth:MetadataAddress"];
            if (!string.IsNullOrEmpty(metadata)) options.MetadataAddress = metadata;
            options.RequireHttpsMetadata = builder.Configuration.GetValue("Auth:RequireHttps", true);
            // 2026-10-05: a provider the api cannot ask is a 503 that names itself, never a 401 that logs everyone out
            options.Events = AuthOutage.Events();
        });
}
// operator routes (/admin, /control, the catalog publish): the token must carry the `admin` scope
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(AdminScope.Policy, policy => policy
        .RequireAuthenticatedUser()
        .RequireAssertion(context => AdminScope.HasAdminScope(context.User)));

var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    // x-jumbo-token: Jumbo hands its session token back in a response
    // header, which the store proxy relays and the browser must see.
    // X-Live-*: the streamed login's frame carries its sequence and size in
    // headers — unexposed, the browser read neither, so the app never
    // advanced its poll (a request storm into 429s that dropped the taps)
    // and sized the picture by a guess (taps landed above the field; user
    // ss 2026-10-01). Retry-After rides along for the pause copy.
    p.WithOrigins(corsOrigins).AllowAnyHeader().AllowAnyMethod()
        .WithExposedHeaders("x-jumbo-token", "X-Live-Sequence", "X-Live-Size", "X-Live-Origin", "Retry-After")));

// abuse guard, partitioned per user (per IP before auth): the global
// bucket and the streamed login's own (ApiRateLimits); the social-
// mutations policy throttles writes that reach OTHER people (invites,
// friend requests, role changes) much harder. Functional tests run with
// TestMode and get effectively-unlimited defaults unless a test sets
// RateLimits keys explicitly (RateLimitTests).
var unlimitedForTests = builder.Configuration.GetValue<bool>("Auth:TestMode") ? int.MaxValue : (int?)null;
var globalTokens = builder.Configuration.GetValue<int?>("RateLimits:GlobalTokens") ?? unlimitedForTests ?? 600;
var globalRefillPer10S = builder.Configuration.GetValue<int?>("RateLimits:GlobalRefillPer10s") ?? unlimitedForTests ?? 60;
var socialPerMinute = builder.Configuration.GetValue<int?>("RateLimits:SocialPerMinute") ?? unlimitedForTests ?? 30;
var liveTokens = builder.Configuration.GetValue<int?>("RateLimits:LiveTokens") ?? unlimitedForTests ?? 1500;
var liveRefillPer10S = builder.Configuration.GetValue<int?>("RateLimits:LiveRefillPer10s") ?? unlimitedForTests ?? 400;
var rateBudgets = new RateLimitBudgets(globalTokens, globalRefillPer10S, liveTokens, liveRefillPer10S);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = (ctx, _) =>
    {
        ctx.HttpContext.Response.Headers.RetryAfter = "10";
        return ValueTask.CompletedTask;
    };
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(http => ApiRateLimits.PartitionFor(http, rateBudgets));
    options.AddPolicy(Munni.Api.Social.SocialEndpoints.MutationsPolicy, http =>
        RateLimitPartition.GetFixedWindowLimiter(ApiRateLimits.KeyFor(http), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = socialPerMinute,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));
});

var app = builder.Build();

if (app.Configuration.GetValue<bool>("Db:AutoMigrate"))
{
    using var scope = app.Services.CreateScope();
    // real migrations: schema evolves in place across releases
    var migrated = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await migrated.Database.MigrateAsync();
    // the 2026-10-05 overlay repair: once per database, remembered in AppSettings
    await TxMetaOverlayRepair.RunOnceAsync(migrated, app.Logger, CancellationToken.None);
    // the 2026-10-07 derived-duplicate repair: the copies a re-keyed ING id left behind, once per database
    await Munni.Api.Connectors.DerivedDuplicateRepair.RunOnceAsync(migrated, app.Logger, CancellationToken.None);
}

// handled errors keep their CORS headers — unhandled exceptions wipe the
// response and the browser misreports them as CORS failures
app.UseExceptionHandler(errorApp => errorApp.Run(async http =>
{
    http.Response.StatusCode = 500;
    await http.Response.WriteAsJsonAsync(new { error = "internal error" });
}));

app.UseCors();
app.UseAuthentication();
// after authentication so the partition key is the OIDC sub, not the IP
    // the 2026-10-09 needs-review repair: rows a prediction alone marked reviewed go back to the review, once per database
    await NeedsReviewRepair.RunOnceAsync(migrated, app.Logger, CancellationToken.None);
app.UseRateLimiter();
app.UseAuthorization();
app.Use(async (http, next) =>
{
    var db = http.RequestServices.GetRequiredService<AppDbContext>();
    await UserResolution.ResolveUser(http, db, () => next(http));
});

// interactive API reference (Scalar) backed by the generated OpenAPI doc
app.MapOpenApi();
app.MapScalarApiReference(options => options.WithTitle("munni API"));

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    build = Environment.GetEnvironmentVariable("BUILD_NUMBER") ?? "dev",
    // version handshake (apps/web/src/lib/protocol.ts owns the bump
    // discipline): native apps deploy on their own cadence — clients
    // compare BOTH directions before syncing and refuse a mismatch
    protocol = ApiProtocol.Version,
    minClientProtocol = ApiProtocol.MinClient,
    capabilities = new
    {
        testAuth = app.Configuration.GetValue<bool>("Auth:TestMode"),
        push = pushCaps.WebPush,
        fcm = pushCaps.Fcm,
        vapidPublicKey = app.Configuration["Push:VapidPublicKey"] ?? "",
        logos = logosEnabled,
        ocr = ocrEnabled,
        quotes = true,
        // the Connections hub's "connect a party" door (#367)
        connectors = connectorsEnabled,
        // user 2026-10-07: invitation-only sign-up — the web app closes its own sign-up door and points at the invitation
        inviteOnly = app.Configuration.GetValue<bool>(AdminInvitationEndpoints.InviteOnlyKey),
    },
}));
app.MapSync();
app.MapDevices();
app.MapSocial();
app.MapSplits();
app.MapPush();
app.MapLogos(app.Configuration);
if (ocrEnabled) app.MapOcr();
app.MapQuotes();
app.MapRates();
app.MapAccounts();
app.MapAdmin();
app.MapControl();
app.MapLab();
app.MapCatalog();
app.MapConnectionSync();
ConnectorSetup.Map(app, connectors);

await app.RunAsync();
