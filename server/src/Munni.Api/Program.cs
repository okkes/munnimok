using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.GoCardless;
using Munni.Api.Sync;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Db")));

builder.Services.AddMemoryCache();
if (!string.IsNullOrEmpty(builder.Configuration["GoCardless:SecretId"]))
{
    builder.Services.AddHttpClient<IGoCardlessApi, GoCardlessApi>(client =>
        client.BaseAddress = new Uri("https://bankaccountdata.gocardless.com/api/v2/"));
    builder.Services.AddHostedService<GcFetchService>();
}

if (builder.Configuration.GetValue<bool>("Auth:TestMode"))
{
    builder.Services
        .AddAuthentication(TestAuthHandler.Scheme)
        .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.Scheme, null);
}
else
{
    // Logto OIDC bearer — configured when the NAS stack lands (Phase 2b)
    builder.Services
        .AddAuthentication("Bearer")
        .AddJwtBearer("Bearer", options =>
        {
            options.Authority = builder.Configuration["Auth:Authority"];
            options.TokenValidationParameters.ValidAudience = builder.Configuration["Auth:Audience"];
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
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreatedAsync();
}

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
    capabilities = new { gocardless = gcEnabled },
}));
app.MapSync();
if (gcEnabled) app.MapGoCardless();

app.Run();

public partial class Program;
