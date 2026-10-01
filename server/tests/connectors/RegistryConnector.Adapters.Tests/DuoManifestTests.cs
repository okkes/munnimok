using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// The manifest is the only contract a consuming app codes against, so the
/// load-bearing facts are asserted by value rather than left to a reader to
/// spot in a builder.
///
/// One of them is not a preference at all but a structural guarantee, and it is
/// the reason DUO is worth having in this shape: a provider declaring
/// <c>remote_browser</c> may declare no fields, and the validator refuses one
/// that does. That is what makes "no DigiD credential ever enters this
/// platform" something a manifest cannot contradict.
/// </summary>
public sealed class DuoManifestTests
{
    private static readonly ProviderManifest Manifest = new DuoAdapter().Describe();

    [Fact]
    public void The_manifest_validates()
    {
        ManifestValidator.Validate(Manifest);

        Assert.Equal("duo", Manifest.Id);
        Assert.Equal(ProviderKind.Registry, Manifest.Kind);
        Assert.Equal("NL", Manifest.Country);

        // TWO. Version 1 was flow 'remote_browser' and collected nothing at
        // all; this one may collect a DigiD username and password. Every
        // bundle is bound to (provider, subject, manifest_version) exactly so
        // that a change to what a login collects cannot be applied to material
        // sealed before it, so anyone connected under 1 signs in again.
        Assert.Equal(2, Manifest.ManifestVersion);
    }

    /// <summary>
    /// WHAT VERSION 2 GAVE UP, stated rather than quietly dropped.
    ///
    /// Version 1 declared <c>remote_browser</c>, which the validator will only
    /// accept from a provider declaring NO fields - so "no DigiD credential can
    /// enter this platform" was a shape the manifest could not contradict. That
    /// is gone, at the account holder's request: DUO re-authenticates on every
    /// sync by design, and retyping a DigiD username and password every time is
    /// the friction that stops somebody syncing at all.
    ///
    /// This test is the replacement, and it asserts what actually still holds.
    /// </summary>
    [Fact]
    public void Both_credentials_are_optional_so_storing_nothing_is_still_a_way_to_connect()
    {
        Assert.Equal(AuthFlow.PasswordSms, Manifest.Auth.Flow);

        var fields = Manifest.Auth.AllFields().ToList();

        // Nothing is required. A person who wants to type their DigiD
        // credentials into DigiD's own page and nowhere else still can, and
        // gets exactly the streamed sign-in version 1 gave them.
        Assert.All(fields, f => Assert.False(f.Required));

        Assert.Contains(fields, f => f.Key == "username");
        Assert.Contains(fields, f => f.Key == "password");
        Assert.Contains(fields, f => f.Key == "method");
    }

    /// <summary>
    /// The custody model is the half that was doing the real work, and it is
    /// untouched: the credential is sealed into a bundle the user's own device
    /// holds, and this platform stores none of it.
    /// </summary>
    [Fact]
    public void The_credential_lives_on_the_users_own_device_and_is_marked_secret()
    {
        Assert.Equal(SecretCustody.Client, Manifest.SecretCustody);
        Assert.True(Manifest.OffersCredentialStore);

        // A password not marked secret would be logged and screenshotted -
        // redaction keys off exactly this flag - and the validator refuses it.
        var password = Assert.Single(Manifest.Auth.AllFields(), f => f.Key == "password");

        Assert.True(password.Secret);
        Assert.Equal(FieldType.Password, password.Type);

        // And DigiD's second factor is untouched by any of it: a code is texted
        // to a phone on every single sign-in, which is what actually stands
        // between a stored password and somebody's dossier.
        Assert.Contains(ChallengeType.MfaCode, Manifest.Auth.Challenges);
    }

    /// <summary>
    /// CONFIRMED rather than assumed: DUO's SAML request carries
    /// <c>ForceAuthn=true</c>, so DigiD re-authenticates the human on every
    /// sync whatever session anybody holds. A manifest claiming otherwise would
    /// make a consumer promise scheduled syncing and then fail at 3am.
    /// </summary>
    [Fact]
    public void Nothing_about_this_provider_runs_without_a_human()
    {
        Assert.False(Manifest.UnattendedFetch);
        Assert.False(Manifest.Auth.Session.Refreshable);
        Assert.False(Manifest.Auth.Session.RotatesOnUse);
        Assert.False(Manifest.Auth.Reauth.Cheap);

        // And this stays false whatever the user stores. A stored password
        // removes the typing, not the human: DigiD still texts a code to a
        // phone on every sign-in, and there is nobody to read it at 3am. A
        // registry that signed itself in with nobody present would be an
        // account takeover with a cron entry.
        Assert.True(Manifest.OffersCredentialStore);
        Assert.False(Manifest.UnattendedFetch);
    }

    /// <summary>
    /// POOLED as of 2026-09-21, and this test is the record of a decision
    /// rather than a description of a field.
    /// </summary>
    /// <remarks>
    /// It said <see cref="AgentClass.Byo"/> from 2026-08-10, for the Logius
    /// reason written out in the manifest, and NOTHING ENFORCED IT: the lease
    /// query matched on provider id and runtime alone, so every DUO run there
    /// has ever been - the live sign-ins of 2026-08-11 included - was served by
    /// the operator's pooled fleet. It was a rule for one day, and the account
    /// holder changed it deliberately once they had been refused by it.
    /// <para>
    /// ASSERTED BY VALUE because the class is a routing rule now and not a
    /// preference. <see cref="AgentRequirement.NeedsOwnMachine"/> is read by
    /// the lease query, by the login's refusal and by the profile pinning, so
    /// putting <c>Byo</c> back here takes DUO away from the fleet in all three
    /// at once and refuses the connect of anybody with no machine of their own
    /// switched on. That is a decision, and a decision should have to walk past
    /// a failing test with this comment on it.
    /// </para>
    /// <para>
    /// The validator has four rules touching this field - agent custody wants
    /// byo, <c>browser_persistent</c> wants byo, a non-http runtime wants an
    /// agent, and <c>required: false</c> implies inline - and DUO is T3 with
    /// client custody and an agent required, so none of them reaches it in
    /// either direction. <see cref="The_manifest_validates"/> is what actually
    /// proves that.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_operators_fleet_may_drive_this_and_the_egress_it_asks_for_is_still_declared()
    {
        // Unchanged and not negotiable: DigiD is a browser login, and a
        // browser cannot run in the control plane's own process.
        Assert.True(Manifest.Agent.Required);

        Assert.Equal(AgentClass.Pooled, Manifest.Agent.Class);
        Assert.Equal(ProviderRuntime.BrowserInteractive, Manifest.Runtime);

        // THE READING ALL THREE ROUTERS SHARE, which is the thing that moved.
        // False means the fleet may lease this login, that a caller with no
        // machine of their own online is not refused at Connect, and that no
        // profile row is pinned to one agent.
        Assert.False(Manifest.Agent.NeedsOwnMachine);

        // STILL DECLARED, and still unenforced by anything. A separate
        // statement from the class: the class says whose machine, this says
        // what DUO wants of whichever machine takes the work, and a Dutch
        // residential address is what it wants for exactly the Logius reason
        // that used to be spelled `Byo` above it.
        Assert.NotNull(Manifest.Agent.Egress);
        Assert.Equal("NL", Manifest.Agent.Egress.Country);
        Assert.Equal("residential", Manifest.Agent.Egress.Kind);

        // A phone answers DigiD, not a keyboard at the agent.
        Assert.False(Manifest.LoginNeedsHeadedAgent);
    }

    /// <summary>
    /// Three now, one per tier: six digits when the credentials are stored, the
    /// streamed page when they are not or when the typed path meets something
    /// it does not recognise, and the QR on the app method.
    /// </summary>
    [Fact]
    public void The_three_challenges_it_may_raise_are_declared()
    {
        Assert.Equal(
            [ChallengeType.MfaCode, ChallengeType.LiveView, ChallengeType.QrDisplay],
            Manifest.Auth.Challenges);
    }

    /// <summary>
    /// The method is a CHOICE and not free text, so a typo cannot silently
    /// send the login down a path DigiD does not offer.
    /// </summary>
    [Fact]
    public void The_method_is_one_of_the_two_digid_paths_a_browser_can_drive()
    {
        var method = Assert.Single(Manifest.Auth.Config);

        Assert.Equal("method", method.Key);
        Assert.Equal(FieldType.Select, method.Type);
        Assert.False(method.Required);
        Assert.Equal(["sms", "app"], method.Options);

        // The other two DigiD methods - a driving licence and an identity card -
        // want an NFC document reader, so no browser can drive them and neither
        // is offered here.
        Assert.DoesNotContain("rijbewijs", method.Options!);
        Assert.DoesNotContain("identiteitskaart", method.Options!);
    }

    /// <summary>
    /// The field that stops a streamed DigiD login cutting out halfway.
    ///
    /// A live view pins to the hosts declared here, and with none declared it
    /// pins to whatever host the page was on when the stream opened. On DUO
    /// that is mijn.duo.nl - so the picture died the instant the human was
    /// sent to DigiD, leaving them a frozen "Bezig met authenticeren..." and a
    /// sign-in they could not complete.
    /// </summary>
    [Fact]
    public void Both_hosts_a_digid_sign_in_spans_are_declared()
    {
        Assert.Equal(["mijn.duo.nl", "login.digid.nl"], Manifest.Auth.LoginOrigins);

        // Exactly two, and neither a wildcard: *.duo.nl would keep the camera
        // running over an authenticated account after the sign-in was over.
        Assert.All(Manifest.Auth.LoginOrigins, o => Assert.DoesNotContain('*', o));
    }

    /// <summary>
    /// AND DIGID'S SESSION IS NOT WORTH BRINGING HOME, which is the same host
    /// in the same spec for the opposite reason.
    /// </summary>
    /// <remarks>
    /// Measured on the owner's live account on 2026-09-28. Four connects in
    /// three minutes: twice on the operator's fleet, where the typed DigiD
    /// sign-in completed with no notes, and twice on their own machine, where
    /// the first fell back to the streamed hand-over with "the typed sign-in did
    /// not complete (ProviderChanged)" and they drove DigiD's "Hoe wilt u
    /// inloggen?" chooser by hand. A fleet agent keeps no profile at all, so its
    /// browser reached login.digid.nl holding nothing; theirs reached it holding
    /// DIGID_SAML_SESSION and four more of DigiD's out of the kept session.
    /// <para>
    /// And none of them could ever have paid for itself: <c>UnattendedFetch</c>
    /// is false here because DUO's SAML request carries ForceAuthn=true, so
    /// DigiD re-authenticates the human every single time whatever session
    /// anybody holds.
    /// </para>
    /// <para>
    /// mijn.duo.nl MUST NOT BE IN THIS LIST, and that is the assertion worth
    /// having. DUO's own session cookies are what make "this profile was still
    /// inside DUO, so nothing was asked of you" work - which the owner saw twice
    /// on the same day - and dropping them would delete the entire reason to run
    /// a BYO agent for this provider.
    /// </para>
    /// </remarks>
    [Fact]
    public void Digids_session_is_dropped_and_duos_own_is_kept()
    {
        Assert.Equal(["login.digid.nl"], Manifest.Auth.DropsKeptSessionFor);

        Assert.DoesNotContain("mijn.duo.nl", Manifest.Auth.DropsKeptSessionFor);

        // And the stream still follows the human there, which is the other half
        // of what this provider is.
        Assert.Contains("login.digid.nl", Manifest.Auth.LoginOrigins);

        // Stated rather than assumed, because the whole argument for dropping
        // DigiD's session rests on it.
        Assert.False(Manifest.UnattendedFetch);
    }

    [Fact]
    public void The_session_lasts_as_long_as_duo_says_it_does()
    {
        // DUO's own sessietoken endpoint answers {"timeout":900}.
        Assert.Equal(900, Manifest.Auth.Session.TtlSeconds);
        Assert.Equal(["session_expired"], Manifest.Auth.Reauth.TriggerCodes);
    }

    [Fact]
    public void The_one_resource_is_a_standing_position_with_no_date_range()
    {
        var debt = Assert.Single(Manifest.Resources);

        Assert.Equal("student-debt", debt.Id);
        Assert.Equal(ResourceShape.StudentDebt, debt.Returns);

        // DUO states what is owed NOW. Declaring `since` would invite a
        // question it has no way to answer.
        Assert.Null(debt.Param("since"));
        Assert.Null(debt.Param("until"));

        // One param, and it is the opt-in that costs something: the booked
        // movements exist only inside DUO's customer dossier, so asking for
        // them means that request is made. Everything else on this record comes
        // from narrow endpoints carrying no identity at all.
        var include = Assert.Single(debt.Params);

        Assert.Equal("include", include.Key);
        Assert.False(include.Required);
        Assert.Contains("ledger", include.Values!);

        // One record for the whole position - see StudentDebt for why that is
        // one and not eight.
        Assert.Equal(1, debt.MaxRecordsPerFetch);
    }

    /// <summary>
    /// A shape declared in a manifest with no record behind it is a promise
    /// nothing keeps: the document generator publishes a schema per shape, and
    /// a caller reads it before it fetches anything.
    /// </summary>
    [Fact]
    public void The_shape_it_returns_resolves_to_a_real_record()
    {
        Assert.Equal(typeof(StudentDebt), RecordShapes.Require(ResourceShape.StudentDebt));
    }

    [Fact]
    public void Describe_is_stable_and_does_no_work()
    {
        var adapter = new DuoAdapter();

        Assert.Same(adapter.Describe(), adapter.Describe());
    }

    [Fact]
    public void The_registry_service_ships_it()
    {
        var registry = new ProviderRegistry(RegistryAdapters.All());

        Assert.True(registry.TryGetAdapter("duo", out var adapter));
        Assert.IsType<DuoAdapter>(adapter);
    }
}
