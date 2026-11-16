using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent.Tests.Configuration;

/// an agent used to serve exactly one control plane; now a list is per connector, while adapters, browser,
/// concurrency limit and profile root are the machine's and shared
public sealed class ConnectorListTests
{
    private const string BankUrl = "https://bank.internal:8392";
    private const string RegistryUrl = "https://registry.internal:8392";

    /// every shipped image and compose file sets the single-connector shorthand: it must still resolve to exactly
    /// one connection, code and authority included
    [Fact]
    public void The_single_control_plane_settings_are_exactly_one_connection()
    {
        var options = new ConnectorAgentOptions
        {
            ControlPlaneBaseUrl = new Uri(BankUrl),
            EnrollmentCode = "AGNT-BANK-0001",
            ControlPlaneCaPath = "/tls/ca.crt.pem",
        };

        var connection = Assert.Single(options.ResolvedConnections());

        Assert.Equal("default", connection.Name);
        Assert.Equal(new Uri(BankUrl), connection.ControlPlaneBaseUrl);
        Assert.Equal("AGNT-BANK-0001", connection.EnrollmentCode);
        Assert.Equal("/tls/ca.crt.pem", connection.ControlPlaneCaPath);

        // the trailing slash makes relative paths resolve instead of replacing the last segment, and is the key the state file uses
        Assert.Equal("https://bank.internal:8392/", connection.RequireBaseAddress().AbsoluteUri);
    }

    /// running agents mount a volume at /profiles holding a signed-in browser (bank-registered, DigiD session): the single
    /// connection owns the root, only a listed connector takes a sub-directory, so an existing volume moves by mounting
    /// at that sub-path
    [Fact]
    public void One_connector_keeps_the_profile_root_and_a_listed_one_takes_a_sub_directory()
    {
        var alone = new ConnectorAgentOptions { ControlPlaneBaseUrl = new Uri(BankUrl) }
            .ResolvedConnections()[0];

        Assert.Equal("/profiles", alone.ProfileRootUnder("/profiles"));

        var listed = new ConnectorConnection { Name = "registry", ControlPlaneBaseUrl = new Uri(RegistryUrl) };

        Assert.Equal(Path.Combine("/profiles", "registry"), listed.ProfileRootUnder("/profiles"));
    }

    /// a container is configured by environment variables only; the two clients are asserted because a list bound into
    /// one object would put one connector's bearer token on the other's requests
    [Fact]
    public void The_environments_spelling_of_the_list_binds_to_a_connector_each()
    {
        // a real one: a connector's authority is read when its client is built
        var authority = WriteCertificateAuthority();

        try
        {
            TheEnvironmentsSpellingOfTheListBindsToAConnectorEach(authority);
        }
        finally
        {
            File.Delete(authority);
        }
    }

    private static void TheEnvironmentsSpellingOfTheListBindsToAConnectorEach(string authority)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                ["ConnectorAgent:AgentName"] = "my nas",
                ["ConnectorAgent:Connections:0:Name"] = "bank",
                ["ConnectorAgent:Connections:0:ControlPlaneBaseUrl"] = BankUrl,
                ["ConnectorAgent:Connections:0:EnrollmentCode"] = "AGNT-BANK-0001",
                ["ConnectorAgent:Connections:1:Name"] = "registry",
                ["ConnectorAgent:Connections:1:ControlPlaneBaseUrl"] = RegistryUrl,
                ["ConnectorAgent:Connections:1:EnrollmentCode"] = "AGNT-REG-0002",
                ["ConnectorAgent:Connections:1:ControlPlaneCaPath"] = authority,
            })
            .Build();

        var services = new ServiceCollection();
        services.AddConnectorAgent(configuration, agent => agent.AddAdapter(new NeverRunsAdapter()));

        using var provider = services.BuildServiceProvider();
        var options = provider.GetRequiredService<ConnectorAgentOptions>();
        var connections = options.ResolvedConnections();

        Assert.Equal(["bank", "registry"], connections.Select(connection => connection.Name));
        Assert.Equal("AGNT-BANK-0001", connections[0].EnrollmentCode);
        Assert.Equal("AGNT-REG-0002", connections[1].EnrollmentCode);

        // two internal CAs on one LAN is the ordinary case
        Assert.Null(connections[0].ControlPlaneCaPath);
        Assert.Equal(authority, connections[1].ControlPlaneCaPath);

        var factory = provider.GetRequiredService<IHttpClientFactory>();

        Assert.Equal(
            new Uri("https://bank.internal:8392/"),
            factory.CreateClient(ControlPlaneClient.ClientNameFor("bank")).BaseAddress);
        Assert.Equal(
            new Uri("https://registry.internal:8392/"),
            factory.CreateClient(ControlPlaneClient.ClientNameFor("registry")).BaseAddress);

        // the keepalives keep their own shorter bound per connector: a pair registered once left the second heartbeat
        // on the long polls' seventy seconds (KeepaliveBoundsTests)
        Assert.Equal(
            options.KeepaliveTimeout,
            factory.CreateClient(ControlPlaneClient.KeepaliveClientNameFor("registry")).Timeout);
        Assert.Equal(
            options.ControlPlaneTimeout,
            factory.CreateClient(ControlPlaneClient.ClientNameFor("registry")).Timeout);
    }

    /// they would share a profile root, so two banks signed into one cookie jar;
    /// case-insensitive because some file systems fold Bank into bank
    [Fact]
    public void Two_connectors_cannot_share_a_name()
    {
        var options = Options(
            new ConnectorConnection { Name = "bank", ControlPlaneBaseUrl = new Uri(BankUrl) },
            new ConnectorConnection { Name = "Bank", ControlPlaneBaseUrl = new Uri(RegistryUrl) });

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("two connections are called 'bank'", ex.Message, StringComparison.Ordinal);
    }

    /// the state file is keyed by control plane (a token is scoped to one connector): a second connection onto it
    /// would overwrite the first's enrollment and burn a one-time code per restart
    [Fact]
    public void Two_connectors_cannot_be_the_same_control_plane()
    {
        var options = Options(
            new ConnectorConnection { Name = "bank", ControlPlaneBaseUrl = new Uri(BankUrl) },
            new ConnectorConnection { Name = "bank-again", ControlPlaneBaseUrl = new Uri(BankUrl) });

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("'bank' and 'bank-again'", ex.Message, StringComparison.Ordinal);
        Assert.Contains("https://bank.internal:8392/", ex.Message, StringComparison.Ordinal);
    }

    /// the likeliest hand-written mistake (an index typed twice, a variable missing from .env);
    /// otherwise the agent serves two of three silently
    [Fact]
    public void A_connector_with_no_control_plane_is_refused_and_named()
    {
        var options = Options(
            new ConnectorConnection { Name = "bank", ControlPlaneBaseUrl = new Uri(BankUrl) },
            new ConnectorConnection { Name = "registry", EnrollmentCode = "AGNT-REG-0002" });

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("connection 'registry' has no ControlPlaneBaseUrl", ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("connection 'bank' has no", ex.Message, StringComparison.Ordinal);
    }

    /// a half-finished migration: .env still carries the single-connector shorthand beside a list;
    /// preferring either serves a connector nobody meant
    [Fact]
    public void The_single_connector_settings_beside_a_list_are_refused()
    {
        var options = Options(new ConnectorConnection { Name = "bank", ControlPlaneBaseUrl = new Uri(BankUrl) });
        options.ControlPlaneBaseUrl = new Uri(RegistryUrl);
        options.EnrollmentCode = "AGNT-REG-0002";

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains(
            "ControlPlaneBaseUrl and EnrollmentCode are set beside a Connections list",
            ex.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void An_agent_with_no_connector_at_all_is_refused()
    {
        var options = new ConnectorAgentOptions();
        options.AddAdapter(new NeverRunsAdapter());

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("ControlPlaneBaseUrl is required", ex.Message, StringComparison.Ordinal);
        Assert.Contains("ConnectorAgent:Connections:0:ControlPlaneBaseUrl", ex.Message, StringComparison.Ordinal);
    }

    /// the authority loads when the first HTTP client is built, inside enrollment: an unmounted path read as
    /// "could not reach the control plane" and was retried for ever
    [Fact]
    public void A_connector_whose_certificate_authority_is_not_there_is_refused()
    {
        var options = Options(new ConnectorConnection
        {
            Name = "registry",
            ControlPlaneBaseUrl = new Uri(RegistryUrl),
            ControlPlaneCaPath = "/tls/ca.crt.pem",
        });

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains(
            "connection 'registry' trusts a certificate authority at '/tls/ca.crt.pem', and there is no file there",
            ex.Message,
            StringComparison.Ordinal);
    }

    private static string WriteCertificateAuthority()
    {
        using var key = ECDsa.Create();

        var request = new CertificateRequest("CN=connector-test-ca", key, HashAlgorithmName.SHA256);
        using var certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));

        var path = Path.Combine(
            Path.GetTempPath(), "connector-agent-tests", Guid.NewGuid().ToString("N") + "-ca.pem");

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, certificate.ExportCertificatePem());

        return path;
    }

    private static ConnectorAgentOptions Options(params ConnectorConnection[] connections)
    {
        var options = new ConnectorAgentOptions();
        options.AddAdapter(new NeverRunsAdapter());
        foreach (var connection in connections) options.Connections.Add(connection);
        return options;
    }

    private sealed class NeverRunsAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => TestRig.Manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
