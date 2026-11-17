using Connector.Kit.Adapters;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Api.Tests.Infrastructure;

/// boots the real Connector.Api host - its own Program.cs and start-up refusals - on Sqlite with development auth
public sealed class ShopApiFactory : WebApplicationFactory<Program>
{
    /// <summary>What <c>X-Connector-Key</c> must carry. Absent, every call is a 401.</summary>
    public const string SharedSecret = "test-connector-key";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "shop-api-tests", Guid.NewGuid().ToString("N"));

    public ShopApiFactory()
    {
        Directory.CreateDirectory(_root);

        // environment variables: options bind eagerly inside Program.cs and env vars come after appsettings.Development.json
        Set("Connector__Mode", "Development");
        Set("Connector__Database__Provider", "Sqlite");
        Set("Connector__Database__ConnectionString", $"Data Source={Path.Combine(_root, "connector.db")}");
        Set("Connector__Auth__SharedSecret", SharedSecret);

        // the captcha provider parks on a challenge; a wider wait only makes the 202 deterministic on a loaded CI agent
        Set("Connector__Timeouts__LoginWaitSeconds", "15");

        // The pushed live view's keep-alive (#429) at a second rather than
        // ten, so a quiet stream proves it keeps itself open inside a test.
        Set("Connector__Timeouts__LiveStreamKeepAliveSeconds", "1");

        // the operator's fleet, named as the local compose file names it: else every agent is owner-scoped and a machine
        // serving several people is unreachable from a test
        Set("Connector__FleetSubjects__0", ConnectorOptions.DevFleetSubject);
    }

    public HttpClient CreateAuthorizedClient()
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add(ConnectorAuth.DevelopmentHeader, SharedSecret);
        return client;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment("Development");

        builder.ConfigureTestServices(services =>
        {
            // no registered mock rotates material, so rotates_on_use has nothing in the shipped fleet to exercise
            services.AddSingleton<IProviderAdapter>(new RotatingStoreAdapter());

            // Jumbo's shape: the only shape a credential store is offerable on; no offline provider has it
            services.AddSingleton<IProviderAdapter>(new DailyLoginAdapter());

            // ASN's shape: the only runtime that routes a session to a profile; its one shipped provider is a bank no test can drive
            services.AddSingleton<IProviderAdapter>(new PersistentStoreAdapter());

            // DUO's shape: agent-required and BYO but not persistent; the routing rules keyed on the runtime and missed it
            services.AddSingleton<IProviderAdapter>(new OwnMachineStoreAdapter());

            // pooled, no address: the only provider where "the operator's fleet" and "a machine of mine" are both real answers
            services.AddSingleton<IProviderAdapter>(new PooledStoreAdapter());

            // Jumbo's and BKR's shape: pooled, residential only; separates an egress failure from a headed-browser one
            services.AddSingleton<IProviderAdapter>(new ResidentialStoreAdapter());

            // budget shape (prod 2026-10-08): rate_limited on a valid session, which used to end the session for good
            services.AddSingleton<IProviderAdapter>(new BudgetStoreAdapter());
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;

        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // Sqlite's connection pool may still hold the file. A leftover
            // temp directory is not worth failing a test run over.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static void Set(string key, string value) => Environment.SetEnvironmentVariable(key, value);
}

/// one host for the whole assembly: a host per class costs more than the isolation is worth; tests scope by subject
[CollectionDefinition(ShopApiCollection.Name)]
public sealed class ShopApiCollection : ICollectionFixture<ShopApiFactory>
{
    public const string Name = "shop-api";
}
