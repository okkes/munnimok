using Connector.Kit.Jobs;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Kit.Agent.Tests.Execution;

// a pooled agent is a fresh Chromium per job, wiped afterwards; a BYO agent is a machine providers have seen, whose browser
// must keep what browsers keep. Differences: their own browser, and it survives the job
public sealed class OwnMachineTests
{
    private static ProviderManifest Manifest(
        ProviderRuntime runtime = ProviderRuntime.BrowserOnce,
        SecretCustody custody = SecretCustody.Client) => new()
    {
        Id = TestRig.ProviderId,
        Name = "Test",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = runtime,
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
        SecretCustody = custody,
        UnattendedFetch = false,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Steps = [],
            Session = new SessionSpec { TtlSeconds = 3600, Refreshable = false },
        },
        Resources = [new ResourceSpec { Id = "receipts", Returns = ResourceShape.Receipt }],
    };

    // read off the runner: a copy of the decision beside the decision would pass with the decision deleted
    private static BrowserLeaseOptions OptionsFor(
        AgentClass agentClass, ProviderManifest manifest, TimeSpan? keptSession = null)
    {
        using var rig = new TestRig(new NeverRunsAdapter(), manifest: manifest);

        rig.Options.Class = agentClass;
        rig.Options.BrowserDevice = "Pixel 5";
        rig.Options.BrowserChannel = "chrome";
        if (keptSession is { } lifetime) rig.Options.KeptSessionLifetime = lifetime;

        return rig.Runner.BrowserOptionsForTest(TestRig.Login(budgetSeconds: 30), manifest);
    }

    private sealed class NeverRunsAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => Manifest();

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    // their providers have seen their Chrome; Playwright's build has no history and is likeliest to get a second-factor prompt
    [Fact]
    public void An_agent_on_your_own_machine_drives_the_browser_you_have()
    {
        Assert.Equal("chrome", OptionsFor(AgentClass.Byo, Manifest()).Channel);

        // And a container gets bundled Chromium, because that is all it has.
        Assert.Null(OptionsFor(AgentClass.Pooled, Manifest()).Channel);
    }

    // ASN binds a browser registration to the browser that made it (trust screen: Chrome on Android, the agent
    // emulates a Pixel): the device must not change under a trusted profile, so agent class is no input to it
    [Fact]
    public void The_device_is_the_agents_configuration_whoever_owns_the_machine()
    {
        Assert.Equal("Pixel 5", OptionsFor(AgentClass.Byo, Manifest()).DeviceName);
        Assert.Equal("Pixel 5", OptionsFor(AgentClass.Pooled, Manifest()).DeviceName);

        var desktop = Manifest() with
        {
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo, DesktopBrowser = true },
        };

        Assert.Null(OptionsFor(AgentClass.Byo, desktop).DeviceName);
    }

    // "a persistent profile exports nothing" held only for agent custody: left alone, client-custody providers sealed an
    // EMPTY bundle and the fleet asked for a sign-in nobody can explain
    [Fact]
    public void A_client_custody_provider_still_seals_its_cookies_even_on_your_machine()
    {
        Assert.False(OptionsFor(AgentClass.Byo, Manifest(custody: SecretCustody.Client)).KeepsCookiesHere);

        Assert.True(
            OptionsFor(
                AgentClass.Byo,
                Manifest(ProviderRuntime.BrowserPersistent, SecretCustody.Agent)).KeepsCookiesHere);
    }

    // without a kept profile a BYO agent is a slower pooled agent signing in from scratch every run; HTTP has no browser to keep
    [Fact]
    public void Every_browser_provider_on_your_machine_keeps_its_profile()
    {
        Assert.NotNull(OptionsFor(AgentClass.Byo, Manifest()).ProfileDirectory);

        Assert.Null(OptionsFor(AgentClass.Byo, Manifest(ProviderRuntime.Http)).ProfileDirectory);

        Assert.Null(OptionsFor(AgentClass.Pooled, Manifest()).ProfileDirectory);
    }

    // login cookies are SESSION cookies (DUO: four) and Chromium writes them to a persistent profile but never loads them again
    // keyed on machine ownership, not custody: a pooled agent's profiles are wiped by design; nothing crosses a wire here
    [Fact]
    public void Only_a_browser_on_your_own_machine_keeps_its_session_when_it_closes()
    {
        Assert.True(OptionsFor(AgentClass.Byo, Manifest()).KeepsSessionAcrossBrowsers);

        Assert.False(OptionsFor(AgentClass.Pooled, Manifest()).KeepsSessionAcrossBrowsers);
        Assert.False(OptionsFor(AgentClass.Inline, Manifest()).KeepsSessionAcrossBrowsers);

        // a decision about the machine, not custody: an agent-custody provider on a container still keeps nothing
        Assert.False(
            OptionsFor(
                AgentClass.Pooled,
                Manifest(ProviderRuntime.BrowserPersistent, SecretCustody.Agent)).KeepsSessionAcrossBrowsers);
    }

    // a session cookie dies with the browser by rule, so keeping one is a judgment pinned here: twelve hours covers this
    // morning's connect serving this evening's fetch and stops short of a weekend on an unattended machine
    [Fact]
    public void The_agent_says_how_long_a_kept_session_is_worth_offering_back()
    {
        Assert.Equal(TimeSpan.FromHours(12), OptionsFor(AgentClass.Byo, Manifest()).KeptSessionLifetime);

        Assert.Equal(
            TimeSpan.FromHours(3),
            OptionsFor(AgentClass.Byo, Manifest(), TimeSpan.FromHours(3)).KeptSessionLifetime);

        // zero hands the browser's own rule back
        Assert.Equal(
            TimeSpan.Zero,
            OptionsFor(AgentClass.Byo, Manifest(), TimeSpan.Zero).KeptSessionLifetime);
    }

    // the agent cannot tell an identity provider from a portal (login.digid.nl is only a hostname); the adapter that read DUO's
    // SAML ForceAuthn=true knows DigiD re-authenticates anyway, so keeping that session is cost without benefit
    [Fact]
    public void A_provider_says_which_of_its_origins_are_not_worth_keeping_a_session_for()
    {
        Assert.Empty(OptionsFor(AgentClass.Byo, Manifest()).DropsKeptSessionFor);

        var declares = Manifest() with
        {
            Auth = Manifest().Auth with { DropsKeptSessionFor = ["login.digid.nl"] },
        };

        Assert.Equal(["login.digid.nl"], OptionsFor(AgentClass.Byo, declares).DropsKeptSessionFor);
    }

    // a fresh id per job would mean a fresh browser per job (the wiped agent); a bundle cannot carry one, so it is derived
    [Fact]
    public void The_same_provider_lands_in_the_same_profile_on_every_run()
    {
        var first = OptionsFor(AgentClass.Byo, Manifest()).ProfileDirectory;
        var second = OptionsFor(AgentClass.Byo, Manifest()).ProfileDirectory;

        Assert.NotNull(first);

        // Compared by leaf, because each rig owns a scratch root of its own.
        Assert.Equal(Path.GetFileName(first), Path.GetFileName(second));
    }

    // other profile ids come from Ids.New, globally unique (profiles table key); deriving from the provider alone gave
    // own-asn everywhere: a second household's heartbeat hit the primary key and was recorded offline
    [Fact]
    public void Two_agents_running_the_same_provider_derive_different_profile_ids()
    {
        var manifest = Manifest();

        var mine = ProfileFor("agt_" + new string('a', 32), manifest);
        var theirs = ProfileFor("agt_" + new string('b', 32), manifest);

        Assert.NotNull(mine);
        Assert.NotNull(theirs);

        // by leaf: each rig owns a scratch root, so the directories differ whatever happens; the ID is the claim
        Assert.NotEqual(Path.GetFileName(mine), Path.GetFileName(theirs));

        Assert.Equal(
            Path.GetFileName(mine),
            Path.GetFileName(ProfileFor("agt_" + new string('a', 32), manifest)));
    }

    // ProfileStore.EnsureSafeId caps an id at 64 characters (a directory name) and the agent id is 36: headroom asserted
    [Fact]
    public void The_derived_id_still_fits_what_a_profile_id_is_allowed_to_be()
    {
        // The longest provider id this platform ships is 20 characters
        // (mock-bank-persistent); 23 leaves room and stays inside the cap.
        var longest = Manifest() with { Id = new string('p', 23) };

        var directory = ProfileFor("agt_" + new string('a', 32), longest);

        Assert.NotNull(directory);
        Assert.InRange(Path.GetFileName(directory).Length, 1, 64);
    }

    private static string? ProfileFor(string agentId, ProviderManifest manifest)
    {
        using var rig = new TestRig(new NeverRunsAdapter(), manifest: manifest);

        rig.Options.Class = AgentClass.Byo;
        rig.Identity.Set(new Connector.Kit.Agent.Transport.AgentEnrollment
        {
            AgentId = agentId,
            Token = "tok",
            ControlPlane = "https://control-plane.test/",
            EnrolledAt = DateTimeOffset.UnixEpoch,
        });

        return rig.Runner.BrowserOptionsForTest(TestRig.Login(budgetSeconds: 30), manifest).ProfileDirectory;
    }
}
