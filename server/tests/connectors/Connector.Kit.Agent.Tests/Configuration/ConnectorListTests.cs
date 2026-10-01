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

/// <summary>
/// ONE AGENT, SEVERAL CONNECTORS - as the configuration states it.
///
/// <para>
/// A household that uses the bank, the shopping and the registry connectors
/// used to run three containers, because an agent process served exactly one
/// control plane: one base address, one enrollment code, one identity. What
/// the person asked for was one agent of their own, and the split was never
/// about them - it is an artefact of the platform being three products.
/// </para>
///
/// <para>
/// So there is a list. Everything in it is per connector; everything outside it
/// - the adapters, the browser, the concurrency limit, the profile root - is
/// the machine's, and is shared. These cases are about the list: that the
/// environment binds it, that the single-connector settings every agent running
/// today uses still mean exactly one connection, and that the four ways of
/// writing it wrong are refused at startup rather than at three in the morning.
/// </para>
/// </summary>
public sealed class ConnectorListTests
{
    private const string BankUrl = "https://bank.internal:8392";
    private const string RegistryUrl = "https://registry.internal:8392";

    /// <summary>
    /// THE SHORTHAND STILL MEANS ONE CONNECTOR, and it is the shape every
    /// agent on this platform is configured with today.
    /// </summary>
    /// <remarks>
    /// Three shipped images and every compose file in <c>deploy/</c> set
    /// <c>ConnectorAgent__ControlPlaneBaseUrl</c> and
    /// <c>ConnectorAgent__EnrollmentCode</c>. If those stopped being a
    /// connection, every one of those agents would come back from a release as
    /// a machine with nowhere to call - so this asserts the whole of what they
    /// resolve into, code and authority included, rather than merely that there
    /// is one of them.
    /// </remarks>
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

        // The trailing slash matters: it is what makes the agent's relative
        // paths resolve instead of replacing the last segment, and it is the
        // key the state file files this enrollment under.
        Assert.Equal("https://bank.internal:8392/", connection.RequireBaseAddress().AbsoluteUri);
    }

    /// <summary>
    /// AND ITS BROWSERS STAY WHERE THEY ARE, which is the upgrade this rests
    /// on.
    /// </summary>
    /// <remarks>
    /// The agents already running have a volume mounted at <c>/profiles</c>
    /// with a signed-in browser in it - a bank that has registered this
    /// browser, a DigiD session DUO accepts. Filing the one connection's
    /// profiles under <c>/profiles/default</c> on the next release would leave
    /// every one of those directories unread, and the account holder would be
    /// asked for the phone, the card and the codes to rebuild what was already
    /// there. So the single connection owns the root itself, and only a listed
    /// connector takes a sub-directory - which is also how an existing volume
    /// moves across: mount it at the sub-path named after the connection.
    /// </remarks>
    [Fact]
    public void One_connector_keeps_the_profile_root_and_a_listed_one_takes_a_sub_directory()
    {
        var alone = new ConnectorAgentOptions { ControlPlaneBaseUrl = new Uri(BankUrl) }
            .ResolvedConnections()[0];

        Assert.Equal("/profiles", alone.ProfileRootUnder("/profiles"));

        var listed = new ConnectorConnection { Name = "registry", ControlPlaneBaseUrl = new Uri(RegistryUrl) };

        Assert.Equal(Path.Combine("/profiles", "registry"), listed.ProfileRootUnder("/profiles"));
    }

    /// <summary>
    /// THE ENVIRONMENT BINDS THE LIST, which is the binding that matters: a
    /// container is configured by environment variables and by nothing else.
    /// </summary>
    /// <remarks>
    /// <c>ConnectorAgent__Connections__0__Name</c> is what a compose file
    /// writes; the environment provider hands it over as
    /// <c>ConnectorAgent:Connections:0:Name</c>, which is what an in-memory
    /// source is given here - the same translation <c>ByoAgentRuntimesTests</c>
    /// does with the shipped compose file.
    /// <para>
    /// The two clients are asserted as well as the settings, because that is
    /// where a list that bound into one object would show: each connector has
    /// a pair of HTTP clients of its own, holding its base address, its
    /// authority and its token, and a pair that answered for both connectors
    /// would be one connector's bearer token on the other's requests.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_environments_spelling_of_the_list_binds_to_a_connector_each()
    {
        // A real one, because a connector's authority is read when its client
        // is built and this test builds them. It is also the shape of the
        // thing: an internally-issued root, mounted beside the compose file.
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

        // One connector's authority is not the other's: two internal CAs on
        // one LAN is the ordinary case, not an exotic one.
        Assert.Null(connections[0].ControlPlaneCaPath);
        Assert.Equal(authority, connections[1].ControlPlaneCaPath);

        var factory = provider.GetRequiredService<IHttpClientFactory>();

        Assert.Equal(
            new Uri("https://bank.internal:8392/"),
            factory.CreateClient(ControlPlaneClient.ClientNameFor("bank")).BaseAddress);
        Assert.Equal(
            new Uri("https://registry.internal:8392/"),
            factory.CreateClient(ControlPlaneClient.ClientNameFor("registry")).BaseAddress);

        // And the keepalives keep their own much shorter bound, per connector.
        // A pair registered once for the process would have left the second
        // connector's heartbeat on the long polls' seventy seconds, which is
        // the defect KeepaliveBoundsTests exists for, reintroduced by a loop.
        Assert.Equal(
            options.KeepaliveTimeout,
            factory.CreateClient(ControlPlaneClient.KeepaliveClientNameFor("registry")).Timeout);
        Assert.Equal(
            options.ControlPlaneTimeout,
            factory.CreateClient(ControlPlaneClient.ClientNameFor("registry")).Timeout);
    }

    /// <summary>
    /// Two connectors with one name are refused: the name is a directory.
    /// </summary>
    /// <remarks>
    /// They would share a profile root, so one connector's lease would drive
    /// the browser the other connector's provider has trusted - two banks
    /// signed into one cookie jar. Case-insensitively, because two of the file
    /// systems this runs on fold <c>Bank</c> into <c>bank</c> without being
    /// asked.
    /// </remarks>
    [Fact]
    public void Two_connectors_cannot_share_a_name()
    {
        var options = Options(
            new ConnectorConnection { Name = "bank", ControlPlaneBaseUrl = new Uri(BankUrl) },
            new ConnectorConnection { Name = "Bank", ControlPlaneBaseUrl = new Uri(RegistryUrl) });

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("two connections are called 'bank'", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Two connectors cannot be the same control plane, because one enrollment
    /// belongs to one of those.
    /// </summary>
    /// <remarks>
    /// The state file is keyed by control plane - a token is scoped to one
    /// connector's <c>/agent/v1/*</c> and is meaningless anywhere else - so a
    /// second connection onto the same address would overwrite the first's
    /// enrollment on every start, and each restart would burn a one-time code
    /// to arrive back where it was. Both names are in the message: an operator
    /// editing a copied block needs to know which two lines to look at.
    /// </remarks>
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

    /// <summary>
    /// A connector with no address is refused, by name.
    /// </summary>
    /// <remarks>
    /// It is the likeliest thing to get wrong in a list written by hand - an
    /// index typed twice, a variable that never made it into the <c>.env</c> -
    /// and the alternative to refusing it is an agent that comes up serving
    /// two connectors out of three and says so nowhere.
    /// </remarks>
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

    /// <summary>
    /// And the shorthand beside the list is refused rather than silently
    /// preferred.
    /// </summary>
    /// <remarks>
    /// This is the shape of a half-finished migration: the <c>.env</c> still
    /// carries <c>ConnectorAgent__ControlPlaneBaseUrl</c> from the
    /// single-connector days and the compose file has grown a list. Taking
    /// either one and ignoring the other is a container that quietly serves a
    /// connector nobody meant it to, so it says which settings are in the way
    /// and stops.
    /// </remarks>
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

    /// <summary>
    /// An agent pointed at nothing at all still refuses to boot, and still
    /// says what to set.
    /// </summary>
    [Fact]
    public void An_agent_with_no_connector_at_all_is_refused()
    {
        var options = new ConnectorAgentOptions();
        options.AddAdapter(new NeverRunsAdapter());

        var ex = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("ControlPlaneBaseUrl is required", ex.Message, StringComparison.Ordinal);
        Assert.Contains("ConnectorAgent:Connections:0:ControlPlaneBaseUrl", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A connector whose certificate authority is not on disk is refused
    /// before it can spend the night retrying.
    /// </summary>
    /// <remarks>
    /// The authority is loaded when the connector's first HTTP client is
    /// built, which happens inside the enrollment attempt - so a path that is
    /// not mounted came back as "enrollment could not reach the control plane",
    /// retried for ever, with nothing in the sentence about a certificate.
    /// This is a compose file forgetting the volume line under the setting,
    /// which is two lines apart in the file people copy.
    /// </remarks>
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

    /// <summary>
    /// A self-signed root in a PEM file, which is what an operator mounts
    /// beside the compose file.
    /// </summary>
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

    /// <summary>An adapter that exists so the options have one; it never runs.</summary>
    private sealed class NeverRunsAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => TestRig.Manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
