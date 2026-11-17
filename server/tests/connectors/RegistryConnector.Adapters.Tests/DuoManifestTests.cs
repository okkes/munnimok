using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

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

        // v2 may collect a DigiD username and password (v1 collected nothing); bundles bind to manifest_version,
        // so anyone connected under v1 signs in again
        Assert.Equal(2, Manifest.ManifestVersion);
    }

    // v1 was remote_browser (no fields allowed); v2 gave that up: DUO re-authenticates every sync,
    // and retyping DigiD credentials every time stops people syncing
    [Fact]
    public void Both_credentials_are_optional_so_storing_nothing_is_still_a_way_to_connect()
    {
        Assert.Equal(AuthFlow.PasswordSms, Manifest.Auth.Flow);

        var fields = Manifest.Auth.AllFields().ToList();

        Assert.All(fields, f => Assert.False(f.Required));

        Assert.Contains(fields, f => f.Key == "username");
        Assert.Contains(fields, f => f.Key == "password");
        Assert.Contains(fields, f => f.Key == "method");
    }

    [Fact]
    public void The_credential_lives_on_the_users_own_device_and_is_marked_secret()
    {
        Assert.Equal(SecretCustody.Client, Manifest.SecretCustody);
        Assert.True(Manifest.OffersCredentialStore);

        // redaction keys off the secret flag; the validator refuses a password not marked secret
        var password = Assert.Single(Manifest.Auth.AllFields(), f => f.Key == "password");

        Assert.True(password.Secret);
        Assert.Equal(FieldType.Password, password.Type);

        // DigiD's second factor stays: a code is texted on every sign-in
        Assert.Contains(ChallengeType.MfaCode, Manifest.Auth.Challenges);
    }

    // DUO's SAML request carries ForceAuthn=true: DigiD re-authenticates the human on every sync
    [Fact]
    public void Nothing_about_this_provider_runs_without_a_human()
    {
        Assert.False(Manifest.UnattendedFetch);
        Assert.False(Manifest.Auth.Session.Refreshable);
        Assert.False(Manifest.Auth.Session.RotatesOnUse);
        Assert.False(Manifest.Auth.Reauth.Cheap);

        // false even with stored credentials: DigiD still texts a code on every sign-in and nobody is there to read it
        Assert.True(Manifest.OffersCredentialStore);
        Assert.False(Manifest.UnattendedFetch);
    }

    // pooled by decision: NeedsOwnMachine is read by the lease query, the login refusal and the profile pinning,
    // so Byo here takes DUO from the fleet in all three and refuses a connect without an own machine
    [Fact]
    public void The_operators_fleet_may_drive_this_and_the_egress_it_asks_for_is_still_declared()
    {
        // DigiD is a browser login and no browser runs in the control plane's process
        Assert.True(Manifest.Agent.Required);

        Assert.Equal(AgentClass.Pooled, Manifest.Agent.Class);
        Assert.Equal(ProviderRuntime.BrowserInteractive, Manifest.Runtime);

        // false: the fleet may lease this login, Connect accepts a caller with no machine, no profile is pinned to an agent
        Assert.False(Manifest.Agent.NeedsOwnMachine);

        // declared, not enforced: a Dutch residential address is what DUO wants of whichever machine takes the work (Logius)
        Assert.NotNull(Manifest.Agent.Egress);
        Assert.Equal("NL", Manifest.Agent.Egress.Country);
        Assert.Equal("residential", Manifest.Agent.Egress.Kind);

        // A phone answers DigiD, not a keyboard at the agent.
        Assert.False(Manifest.LoginNeedsHeadedAgent);
    }

    [Fact]
    public void The_three_challenges_it_may_raise_are_declared()
    {
        Assert.Equal(
            [ChallengeType.MfaCode, ChallengeType.LiveView, ChallengeType.QrDisplay],
            Manifest.Auth.Challenges);
    }

    // a choice, not free text: a typo must not send the login down a path DigiD does not offer
    [Fact]
    public void The_method_is_one_of_the_two_digid_paths_a_browser_can_drive()
    {
        var method = Assert.Single(Manifest.Auth.Config);

        Assert.Equal("method", method.Key);
        Assert.Equal(FieldType.Select, method.Type);
        Assert.False(method.Required);
        Assert.Equal(["sms", "app"], method.Options);

        // driving licence and identity card need an NFC reader, so no browser can drive them
        Assert.DoesNotContain("rijbewijs", method.Options!);
        Assert.DoesNotContain("identiteitskaart", method.Options!);
    }

    // a live view pins to the declared hosts, else to the page's host at stream start (mijn.duo.nl):
    // the picture died when the human was sent to DigiD
    [Fact]
    public void Both_hosts_a_digid_sign_in_spans_are_declared()
    {
        Assert.Equal(["mijn.duo.nl", "login.digid.nl"], Manifest.Auth.LoginOrigins);

        // exactly two, no wildcard: *.duo.nl would keep the camera on an authenticated account after sign-in
        Assert.All(Manifest.Auth.LoginOrigins, o => Assert.DoesNotContain('*', o));
    }

    // DigiD's session is not worth keeping: ForceAuthn re-authenticates every time
    // mijn.duo.nl must NOT be listed: DUO's own cookies make "still inside DUO, nothing asked" work, the reason for BYO
    [Fact]
    public void Digids_session_is_dropped_and_duos_own_is_kept()
    {
        Assert.Equal(["login.digid.nl"], Manifest.Auth.DropsKeptSessionFor);

        Assert.DoesNotContain("mijn.duo.nl", Manifest.Auth.DropsKeptSessionFor);

        Assert.Contains("login.digid.nl", Manifest.Auth.LoginOrigins);

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

        // DUO states what is owed now; a `since` would invite a question it cannot answer
        Assert.Null(debt.Param("since"));
        Assert.Null(debt.Param("until"));

        // the one param is the opt-in that costs: booked movements exist only in DUO's customer dossier,
        // so asking makes that request
        var include = Assert.Single(debt.Params);

        Assert.Equal("include", include.Key);
        Assert.False(include.Required);
        Assert.Contains("ledger", include.Values!);

        Assert.Equal(1, debt.MaxRecordsPerFetch);
    }

    // a shape in a manifest with no record behind it is a promise nothing keeps: the generator publishes a schema per shape
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
