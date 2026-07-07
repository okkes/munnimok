using FluentValidation;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Admin;
using Munni.Api.GoCardless;
using Munni.Api.Push;
using Munni.Api.Social;
using Munni.Api.Sync;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Db")));

builder.Services.AddMemoryCache();
// request-body validators (Validation/Validators.cs) — UI input is never trusted
builder.Services.AddValidatorsFromAssemblyContaining<Program>(ServiceLifetime.Singleton);

// web push: enabled when a VAPID key pair is configured
var pushEnabled = !string.IsNullOrEmpty(builder.Configuration["Push:VapidPublicKey"])
                  && !string.IsNullOrEmpty(builder.Configuration["Push:VapidPrivateKey"]);
if (pushEnabled) builder.Services.AddSingleton<IPushSender, WebPushSender>();
builder.Services.AddScoped(sp => new PushNotifier(
    sp.GetRequiredService<AppDbContext>(),
    sp.GetService<IPushSender>() ?? new NoopPushSender(),
    sp.GetRequiredService<ILogger<PushNotifier>>()));

if (!string.IsNullOrEmpty(builder.Configuration["GoCardless:SecretId"]))
{
    // fixed vendor endpoint, overridable for tests/self-hosted proxies
    var gcBaseUrl = builder.Configuration["GoCardless:BaseUrl"] ?? "https://bankaccountdata.gocardless.com/api/v2/"; // NOSONAR(S1075) vendor API base
    builder.Services.AddHttpClient<IGoCardlessApi, GoCardlessApi>(client =>
        client.BaseAddress = new Uri(gcBaseUrl));
    builder.Services.AddHostedService<GcFetchService>();
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
        });
}
builder.Services.AddAuthorization();

var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(corsOrigins).AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

if (app.Configuration.GetValue<bool>("Db:AutoMigrate"))
{
    using var scope = app.Services.CreateScope();
    // real migrations: schema evolves in place across releases
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
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
app.UseAuthorization();
app.Use(async (http, next) =>
{
    var db = http.RequestServices.GetRequiredService<AppDbContext>();
    await UserResolution.ResolveUser(http, db, () => next(http));
});

var gcEnabled = !string.IsNullOrEmpty(app.Configuration["GoCardless:SecretId"]);
app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    build = Environment.GetEnvironmentVariable("BUILD_NUMBER") ?? "dev",
    capabilities = new
    {
        gocardless = gcEnabled,
        testAuth = app.Configuration.GetValue<bool>("Auth:TestMode"),
        push = pushEnabled,
        vapidPublicKey = app.Configuration["Push:VapidPublicKey"] ?? "",
    },
}));
app.MapSync();
app.MapSocial();
app.MapPush();
app.MapAdmin(gcEnabled);
if (gcEnabled) app.MapGoCardless();

await app.RunAsync();
