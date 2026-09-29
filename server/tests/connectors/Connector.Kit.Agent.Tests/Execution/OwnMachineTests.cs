using Connector.Kit.Jobs;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// What changes when the agent is somebody's own computer.
///
/// <para>
/// A pooled agent is a container: a fresh Chromium per job, emulating a phone,
/// wiped afterwards, identical to every other run. That is right for a
/// datacenter and wrong for a house. An agent somebody installed is a machine
/// their providers have seen before, and the whole reason to install one is
/// that the browser keeps what browsers keep - so the second sign-in is usually
/// no sign-in at all.
/// </para>
///
/// <para>
/// Three differences, and each one was a defect while it was missing: the
/// browser is theirs rather than bundled, it is not pretending to be a phone,
/// and it survives the job.
/// </para>
/// </summary>
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

    /// <summary>
    /// The lease options a runner on this class of agent would build.
    /// </summary>
    /// <remarks>
    /// Read off the runner rather than restated here: a copy of the decision
    /// beside the decision would pass with the decision deleted, which is the
    /// failure this suite has spent the week removing.
    /// </remarks>
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

    /// <summary>
    /// THEIR BROWSER, NOT THE ONE PLAYWRIGHT SHIPS.
    /// </summary>
    /// <remarks>
    /// Their providers have seen their Chrome. A build no consumer ships, with
    /// no history, is the version of that machine most likely to be asked for a
    /// second factor - and it is 150 MB an agent then has to download onto a
    /// laptop that already has a browser.
    /// </remarks>
    [Fact]
    public void An_agent_on_your_own_machine_drives_the_browser_you_have()
    {
        Assert.Equal("chrome", OptionsFor(AgentClass.Byo, Manifest()).Channel);

        // And a container gets bundled Chromium, because that is all it has.
        Assert.Null(OptionsFor(AgentClass.Pooled, Manifest()).Channel);
    }

    /// <summary>
    /// AND IT PRESENTS THE SAME WAY WHOEVER OWNS IT.
    /// </summary>
    /// <remarks>
    /// This asserted the opposite for two commits, on the argument that a
    /// desktop should not claim to be a phone. A live run overruled it: ASN
    /// binds a browser registration to the browser that made it - its own trust
    /// screen reads "Meld de Chrome browser aan op dit Android apparaat",
    /// Android because the agent emulates a Pixel - and a profile registered as
    /// one browser and then driven as another is a profile whose trust the bank
    /// has every reason to withdraw.
    /// <para>
    /// Consistency beats plausibility. What must never happen is the device
    /// changing underneath a profile somebody has already had trusted, and the
    /// surest way to guarantee that is for the class of agent not to be an
    /// input to the answer at all.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_device_is_the_agents_configuration_whoever_owns_the_machine()
    {
        Assert.Equal("Pixel 5", OptionsFor(AgentClass.Byo, Manifest()).DeviceName);
        Assert.Equal("Pixel 5", OptionsFor(AgentClass.Pooled, Manifest()).DeviceName);

        // A provider that insists on a desktop still gets one, on either.
        var desktop = Manifest() with
        {
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo, DesktopBrowser = true },
        };

        Assert.Null(OptionsFor(AgentClass.Byo, desktop).DeviceName);
    }

    /// <summary>
    /// AND THE COOKIES STILL REACH THE BUNDLE, unless custody says otherwise.
    /// </summary>
    /// <remarks>
    /// The rule used to be "a persistent profile exports nothing", which was
    /// the same thing as agent custody right up until a BYO agent started
    /// running ordinary providers persistently. Left alone it would have sealed
    /// an EMPTY bundle for every client-custody provider - working perfectly
    /// while the machine was on, and then the fleet picks up a session with no
    /// cookies in it and asks for a sign-in nobody can explain.
    /// </remarks>
    [Fact]
    public void A_client_custody_provider_still_seals_its_cookies_even_on_your_machine()
    {
        Assert.False(OptionsFor(AgentClass.Byo, Manifest(custody: SecretCustody.Client)).KeepsCookiesHere);

        // Agent custody is the case the rule was written for, and it still
        // holds: nothing about that session may leave the machine.
        Assert.True(
            OptionsFor(
                AgentClass.Byo,
                Manifest(ProviderRuntime.BrowserPersistent, SecretCustody.Agent)).KeepsCookiesHere);
    }

    /// <summary>
    /// AND THE BROWSER SURVIVES THE JOB, for every provider that has one.
    /// </summary>
    /// <remarks>
    /// This is the whole reason somebody installs an agent. Without it a BYO
    /// agent is a slower pooled agent that happens to live in your house: it
    /// signs in to your bank from scratch every single run, which is the cost
    /// the persistent profile exists to remove.
    /// <para>
    /// Not for HTTP providers, which have no browser to keep.
    /// </para>
    /// </remarks>
    [Fact]
    public void Every_browser_provider_on_your_machine_keeps_its_profile()
    {
        Assert.NotNull(OptionsFor(AgentClass.Byo, Manifest()).ProfileDirectory);

        Assert.Null(OptionsFor(AgentClass.Byo, Manifest(ProviderRuntime.Http)).ProfileDirectory);

        // A container keeps nothing: a pooled browser provider is wiped
        // between jobs, which is what makes one pooled run indistinguishable
        // from the next.
        Assert.Null(OptionsFor(AgentClass.Pooled, Manifest()).ProfileDirectory);
    }

    /// <summary>
    /// AND THE PROFILE KEEPS THE SESSION, not merely the directory.
    /// </summary>
    /// <remarks>
    /// The test above says the browser survives the job, and for a year that
    /// was read as "so the login survives too". It never did. Every cookie that
    /// carries a provider's login is a SESSION cookie - measured on DUO, whose
    /// whole session is four of them - and Chromium writes those into a
    /// persistent profile without ever loading them again. So the profile kept
    /// the analytics and the language preference and threw the login away, and
    /// the promise this whole tier is built on was false for every provider.
    /// <para>
    /// KEYED ON THE SAME QUESTION AS EVERY OTHER LINE HERE, because it has to
    /// be. A pooled agent's profiles are wiped between jobs by design, and a
    /// datacenter container that resurrected a bank session after its browser
    /// closed would be the opposite of what that tier promises. This is not the
    /// custody question <c>KeepsCookiesHere</c> answers: nothing crosses a
    /// wire, the cookies go back into the profile they came out of.
    /// </para>
    /// </remarks>
    [Fact]
    public void Only_a_browser_on_your_own_machine_keeps_its_session_when_it_closes()
    {
        Assert.True(OptionsFor(AgentClass.Byo, Manifest()).KeepsSessionAcrossBrowsers);

        Assert.False(OptionsFor(AgentClass.Pooled, Manifest()).KeepsSessionAcrossBrowsers);
        Assert.False(OptionsFor(AgentClass.Inline, Manifest()).KeepsSessionAcrossBrowsers);

        // And it is a decision about the MACHINE rather than about custody, so
        // an agent-custody provider on a container still keeps nothing.
        Assert.False(
            OptionsFor(
                AgentClass.Pooled,
                Manifest(ProviderRuntime.BrowserPersistent, SecretCustody.Agent)).KeepsSessionAcrossBrowsers);
    }

    /// <summary>
    /// AND HOW LONG IT KEEPS IT IS THE AGENT'S TO SAY.
    /// </summary>
    /// <remarks>
    /// The browser's own rule is that a session cookie dies with the browser,
    /// and keeping one deliberately breaks it - so the bound is the judgment the
    /// whole change rests on, and it is pinned here rather than left to drift.
    /// Twelve hours covers the connect somebody did this morning still serving
    /// this evening's fetch, and stops well short of carrying a live bank
    /// session across a weekend on a machine nobody is sitting at.
    /// </remarks>
    [Fact]
    public void The_agent_says_how_long_a_kept_session_is_worth_offering_back()
    {
        Assert.Equal(TimeSpan.FromHours(12), OptionsFor(AgentClass.Byo, Manifest()).KeptSessionLifetime);

        Assert.Equal(
            TimeSpan.FromHours(3),
            OptionsFor(AgentClass.Byo, Manifest(), TimeSpan.FromHours(3)).KeptSessionLifetime);

        // Zero hands the browser's own rule back, which is what makes this an
        // option rather than a number to argue about in a review.
        Assert.Equal(
            TimeSpan.Zero,
            OptionsFor(AgentClass.Byo, Manifest(), TimeSpan.Zero).KeptSessionLifetime);
    }

    /// <summary>
    /// AND WHICH PART OF THE SESSION IS WORTH KEEPING IS THE PROVIDER'S TO SAY.
    /// </summary>
    /// <remarks>
    /// The only decision on this list the agent has no opinion about, and it
    /// cannot have one: nothing on this side of the seam can tell an identity
    /// provider from a portal, because <c>login.digid.nl</c> is a hostname to a
    /// browser. The adapter that read DUO's SAML request and found
    /// <c>ForceAuthn=true</c> knows that DigiD re-authenticates the human
    /// whatever session anybody holds, so keeping that session is cost with no
    /// benefit - and on the owner's own machine on 2026-09-28 it was the one
    /// difference between a typed sign-in that completed on the fleet and one
    /// that fell back to a hand-over at home.
    /// <para>
    /// Empty for every provider that says nothing, which keeps the whole
    /// session exactly as before this field existed.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND IT IS THE SAME PROFILE EVERY TIME.
    /// </summary>
    /// <remarks>
    /// A fresh id per job would create a fresh browser per job and quietly
    /// reproduce the wiped agent this replaces - persistent in name, signing in
    /// from scratch in fact. An ordinary provider's bundle has nowhere to carry
    /// a profile id, so the id is derived rather than minted.
    /// </remarks>
    [Fact]
    public void The_same_provider_lands_in_the_same_profile_on_every_run()
    {
        var first = OptionsFor(AgentClass.Byo, Manifest()).ProfileDirectory;
        var second = OptionsFor(AgentClass.Byo, Manifest()).ProfileDirectory;

        Assert.NotNull(first);

        // Compared by leaf, because each rig owns a scratch root of its own.
        Assert.Equal(Path.GetFileName(first), Path.GetFileName(second));
    }

    /// <summary>
    /// AND TWO MACHINES RUNNING IT DO NOT NAME THE SAME PROFILE.
    /// </summary>
    /// <remarks>
    /// Every other profile id is minted by <c>Ids.New</c> and is unique
    /// everywhere; the control plane's <c>profiles</c> table is keyed on that
    /// alone. This one is DERIVED, so the same provider lands in the same
    /// browser on every run - and deriving it from the provider alone made it
    /// <c>own-asn</c> on every machine in the world that had run ASN.
    /// <para>
    /// The cost was not a duplicate row. The second household's heartbeat
    /// carried a profile the first had already inserted, the insert violated
    /// the primary key, and the heartbeat sharing that transaction died with
    /// it - so their agent ran perfectly while the control plane recorded it
    /// offline for ever: no fleet head-start, offline in every consumer, and
    /// one Debug line on a machine nobody reads. Unreachable with one agent,
    /// which is why standing one up live did not find it.
    /// </para>
    /// </remarks>
    [Fact]
    public void Two_agents_running_the_same_provider_derive_different_profile_ids()
    {
        var manifest = Manifest();

        var mine = ProfileFor("agt_" + new string('a', 32), manifest);
        var theirs = ProfileFor("agt_" + new string('b', 32), manifest);

        Assert.NotNull(mine);
        Assert.NotNull(theirs);

        // By leaf: each rig owns a scratch root, so the directories differ
        // whatever happens. The ID is the claim.
        Assert.NotEqual(Path.GetFileName(mine), Path.GetFileName(theirs));

        // And still stable for one agent, which is the whole reason it is
        // derived rather than minted.
        Assert.Equal(
            Path.GetFileName(mine),
            Path.GetFileName(ProfileFor("agt_" + new string('a', 32), manifest)));
    }

    /// <summary>
    /// And it still fits what a profile id is allowed to be.
    /// </summary>
    /// <remarks>
    /// <c>ProfileStore.EnsureSafeId</c> caps one at 64 characters because it
    /// becomes a directory name, and the agent id this now carries is 36 of
    /// them. A long enough provider id would push a working agent over that
    /// line and fail every job on a path error - so the headroom is asserted
    /// rather than assumed.
    /// </remarks>
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

    /// <summary>The profile directory a runner with this identity would use.</summary>
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
