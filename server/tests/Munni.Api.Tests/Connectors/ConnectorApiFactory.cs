using BankConnector.Adapters;
using Connector.Kit.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Munni.Api.Connectors;
using Munni.Api.Data;
using RegistryConnector.Adapters;
using ShopConnector.Adapters;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The real connector control plane, in-process: <c>Connector.Kit.Hosting</c>
/// composed the way <c>Connector.Api/Program.cs</c> composes it, every pack
/// registered so the catalogue is the shipped one, Sqlite under a temp
/// directory, development auth. The relay under test reaches it through a
/// TestServer handler — the same code path a socket would take, minus the
/// socket.
/// </summary>
public sealed class ControlPlaneHost : IAsyncDisposable
{
    public const string DevKey = "test-connector-key";

    private readonly WebApplication _app;
    private readonly string _root;

    private ControlPlaneHost(WebApplication app, string root)
    {
        _app = app;
        _root = root;
    }

    public TestServer Server => _app.GetTestServer();

    public static async Task<ControlPlaneHost> StartAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "munni-relay-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Connector:Mode"] = "Development",
            ["Connector:Database:Provider"] = "Sqlite",
            ["Connector:Database:ConnectionString"] = $"Data Source={Path.Combine(root, "connector.db")}",
            ["Connector:Auth:SharedSecret"] = DevKey,
            // a loaded CI agent: the wait only makes a 202 deterministic
            ["Connector:Timeouts:LoginWaitSeconds"] = "15",
            // one second, so the slow mock's fetch outruns the window and
            // the job path — poll, answer, collect — is exercised for real
            ["Connector:Timeouts:FetchWaitSeconds"] = "1",
        });
        builder.WebHost.UseTestServer();
        builder.Logging.SetMinimumLevel(LogLevel.Warning);

        builder.Services.AddConnectorPlatform(builder.Configuration, platform =>
        {
            foreach (var adapter in BankAdapters.All(new BankAdapterOptions())) platform.AddAdapter(adapter);
            foreach (var adapter in ShopAdapters.All(new ShopAdapterOptions())) platform.AddAdapter(adapter);
            foreach (var adapter in RegistryAdapters.All(new RegistryAdapterOptions())) platform.AddAdapter(adapter);
        });

        var app = builder.Build();
        app.UseConnectorPlatform();
        app.MapConnectorApi();
        app.MapAgentApi();
        await app.StartAsync();
        return new ControlPlaneHost(app, root);
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // Sqlite may still hold the file; a leftover temp directory is not worth a failed run
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}

/// <summary>
/// munni's API with the relay configured against the in-process control
/// plane: test auth, an in-memory database of its own, the development key
/// as the transport, a public agent address so enrollment renders a command.
/// </summary>
public sealed class ConnectorApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string SubjectSalt = "relay-test-salt";
    public const string AgentPublicUrl = "https://api.munni.test/connector/";

    private readonly string _databaseName = $"connector-tests-{Guid.NewGuid():N}";

    public ControlPlaneHost ControlPlane { get; private set; } = null!;

    public async Task InitializeAsync() => ControlPlane = await ControlPlaneHost.StartAsync();

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
        await ControlPlane.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("Connectors:BaseUrl", "http://connector.test/");
        builder.UseSetting("Connectors:DevKey", ControlPlaneHost.DevKey);
        builder.UseSetting("Connectors:SubjectSalt", SubjectSalt);
        builder.UseSetting("Connectors:AgentPublicUrl", AgentPublicUrl);
        builder.UseSetting("Connectors:LoginsPerHour", "1000");
        builder.UseSetting("Connectors:SyncsPerHour", "1000");
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));

            // the relay's client talks to the in-process control plane
            services.AddHttpClient<ConnectorClient>()
                .ConfigurePrimaryHttpMessageHandler(() => ControlPlane.Server.CreateHandler());
        });
    }

    /// <summary>A signed-in client for a subject, on a named device.</summary>
    public HttpClient ClientFor(string sub, string? platform = null, string? scope = null)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", $"device-{sub}");
        if (platform is not null) client.DefaultRequestHeaders.Add("X-Munni-Platform", platform);
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    /// <summary>Reads through a fresh scope, so a test sees what the handlers committed.</summary>
    public T Read<T>(Func<AppDbContext, T> query)
    {
        using var scope = Services.CreateScope();
        return query(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }
}
