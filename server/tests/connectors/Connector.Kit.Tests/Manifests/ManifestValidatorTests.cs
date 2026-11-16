using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests;

// a manifest that lies makes the consuming app promise things to users and then fail
public sealed class ManifestValidatorTests
{
    private static InvalidOperationException Rejects(ProviderManifest manifest) =>
        Assert.Throws<InvalidOperationException>(() => ManifestValidator.Validate(manifest));

    [Fact]
    public void The_baseline_fixture_is_valid()
    {
        ManifestValidator.Validate(Make.Manifest());
    }

    [Fact]
    public void Rejects_server_custody_without_unattended()
    {
        // a stored secret that needs a human present buys risk and no feature
        var ex = Rejects(Make.Manifest() with { SecretCustody = SecretCustody.Server, UnattendedFetch = false });

        // the rule concerns the FETCH loop, not the login, hence the axis name in the message
        Assert.Contains("unattended_fetch: true", ex.Message, StringComparison.Ordinal);
    }

    // no browser exists for a human to sit at: the flag would be a routing constraint nothing can satisfy
    [Fact]
    public void Rejects_a_headed_login_requirement_on_a_provider_with_no_browser()
    {
        var ex = Rejects(Make.Manifest() with { LoginNeedsHeadedAgent = true });

        Assert.Contains("login_needs_headed_agent", ex.Message, StringComparison.Ordinal);
        Assert.Contains("there is no browser for anyone to sit at", ex.Message, StringComparison.Ordinal);
    }

    // the split exists for a token that fetches unattended while its login may meet a wall only someone at that machine passes
    [Fact]
    public void Accepts_a_provider_that_fetches_unattended_but_needs_a_human_at_the_browser_to_connect()
    {
        ManifestValidator.Validate(
            (Make.Manifest() with
            {
                Runtime = ProviderRuntime.BrowserOnce,
                Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
                UnattendedFetch = true,
                LoginNeedsHeadedAgent = true,
            })
            .WithSession(new SessionSpec { TtlSeconds = 86_400, Refreshable = true }));
    }

    [Fact]
    public void A_manifest_says_nothing_happens_upstream_on_disconnect_unless_it_says_so()
    {
        // the default is the safe claim: most adapters inherit a no-op logout
        Assert.Equal(LogoutSupport.None, Make.Manifest().Logout);
    }

    // Jumbo's shape: client custody, password form, unrefreshable session; without the store the human retypes it daily
    [Fact]
    public void Accepts_a_credential_store_on_a_password_login_whose_session_cannot_be_refreshed()
    {
        ManifestValidator.Validate(Make.Manifest() with { OffersCredentialStore = true });
    }

    [Fact]
    public void A_manifest_offers_no_credential_store_unless_it_says_so()
    {
        // a stored password is the heaviest thing held for somebody; opting in must be written down
        Assert.False(Make.Manifest().OffersCredentialStore);
    }

    // refresh already spares the human; a stored password adds the one credential that neither rotates nor can be revoked here
    [Fact]
    public void Rejects_a_credential_store_where_the_session_refreshes_itself()
    {
        var ex = Rejects(
            (Make.Manifest() with { OffersCredentialStore = true })
            .WithSession(new SessionSpec { TtlSeconds = 86_400, Refreshable = true }));

        Assert.Contains("offers_credential_store is refused on a refreshable session", ex.Message, StringComparison.Ordinal);
    }

    // a streamed login collects nothing to seal; a store offer would advertise a bundle that always arrives empty
    [Fact]
    public void Rejects_a_credential_store_on_a_login_that_collects_nothing()
    {
        var manifest = Make.Manifest() with
        {
            OffersCredentialStore = true,
            Runtime = ProviderRuntime.BrowserOnce,
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
            Auth = Make.Auth() with { Flow = AuthFlow.RemoteBrowser, Steps = [] },
        };

        var ex = Rejects(manifest);

        Assert.Contains("offers_credential_store needs an auth step with fields", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(SecretCustody.Server)]
    [InlineData(SecretCustody.Agent)]
    public void Rejects_a_credential_store_where_the_credential_is_not_the_users_to_hold(SecretCustody custody)
    {
        var ex = Rejects(Make.Manifest() with { OffersCredentialStore = true, SecretCustody = custody });

        Assert.Contains("offers_credential_store needs secret_custody 'client'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Accepts_server_custody_when_the_provider_really_is_unattended()
    {
        ManifestValidator.Validate(
            (Make.Manifest() with { SecretCustody = SecretCustody.Server, UnattendedFetch = true })
            .WithSession(new SessionSpec { TtlSeconds = 86_400, Refreshable = true }));
    }

    [Fact]
    public void Rejects_agent_custody_outside_a_persistent_browser_profile()
    {
        // agent custody means the control plane holds nothing, which only works when a specific machine holds the session
        var ex = Rejects(Make.Manifest() with { SecretCustody = SecretCustody.Agent });

        Assert.Contains("browser_persistent", ex.Message, StringComparison.Ordinal);
        Assert.Contains("byo", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_agent_custody_on_a_pooled_agent()
    {
        var ex = Rejects(Make.Manifest() with
        {
            SecretCustody = SecretCustody.Agent,
            Runtime = ProviderRuntime.BrowserPersistent,
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
        });

        Assert.Contains("byo", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Accepts_the_full_byo_persistent_shape()
    {
        // ASN edge login: authenticated once into a profile on the user's own hardware, no login endpoint after, no secret here
        ManifestValidator.Validate(Make.Manifest() with
        {
            Runtime = ProviderRuntime.BrowserPersistent,
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
            SecretCustody = SecretCustody.Agent,
            UnattendedFetch = true,
            Auth = Make.Auth() with
            {
                Flow = AuthFlow.DevicePersistent,
                Steps = [],
                Session = new SessionSpec { TtlSeconds = 31_536_000, Refreshable = false },
            },
        });
    }

    [Theory]
    [InlineData(ProviderRuntime.BrowserOnce)]
    [InlineData(ProviderRuntime.BrowserInteractive)]
    [InlineData(ProviderRuntime.BrowserPersistent)]
    public void Rejects_a_browser_runtime_without_an_agent(ProviderRuntime runtime)
    {
        // the control plane has no browser binaries; running one there would put provider traffic on the wrong egress
        var ex = Rejects(Make.Manifest() with { Runtime = runtime });

        Assert.Contains("needs an agent", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_non_inline_class_that_claims_it_needs_no_agent()
    {
        var ex = Rejects(Make.Manifest() with
        {
            Agent = new AgentRequirement { Required = false, Class = AgentClass.Pooled },
        });

        Assert.Contains("inline", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_persistent_profile_outside_byo_hardware()
    {
        var ex = Rejects(Make.Manifest() with
        {
            Runtime = ProviderRuntime.BrowserPersistent,
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
            Auth = Make.Auth() with { Flow = AuthFlow.DevicePersistent, Steps = [] },
        });

        Assert.Contains("BYO-only", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Accepts_http_running_inline()
    {
        ManifestValidator.Validate(Make.Manifest() with { Runtime = ProviderRuntime.Http });
    }

    [Fact]
    public void Rejects_a_password_field_that_is_not_marked_secret()
    {
        // redaction keys off this flag, so an unmarked password would be logged and screenshotted
        var ex = Rejects(Make.Manifest().WithFields(
            new FieldSpec { Key = "username", Type = FieldType.Text },
            new FieldSpec { Key = "password", Type = FieldType.Password, Secret = false }));

        Assert.Contains("password", ex.Message, StringComparison.Ordinal);
        Assert.Contains("secret", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_unattended_without_a_refreshable_session()
    {
        var ex = Rejects((Make.Manifest() with { UnattendedFetch = true })
            .WithSession(new SessionSpec { TtlSeconds = 86_400, Refreshable = false }));

        Assert.Contains("refreshable", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Accepts_unattended_with_a_refreshable_session()
    {
        ManifestValidator.Validate((Make.Manifest() with { UnattendedFetch = true })
            .WithSession(new SessionSpec { TtlSeconds = 86_400, Refreshable = true }));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Rejects_a_session_with_no_lifetime(int ttl)
    {
        var ex = Rejects(Make.Manifest().WithSession(new SessionSpec { TtlSeconds = ttl, Refreshable = false }));

        Assert.Contains("ttl_seconds", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_credential_flow_with_no_steps()
    {
        var ex = Rejects(Make.Manifest() with { Auth = Make.Auth() with { Steps = [] } });

        Assert.Contains("at least one auth step", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_device_persistent_on_a_runtime_that_has_no_persistent_profile()
    {
        var ex = Rejects(Make.Manifest() with
        {
            Auth = Make.Auth() with { Flow = AuthFlow.DevicePersistent, Steps = [] },
        });

        Assert.Contains("device_persistent", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_select_field_with_no_options()
    {
        // a consumer renders a picker; no options is an empty dropdown nobody can get past
        var ex = Rejects(Make.Manifest().WithFields(
            new FieldSpec { Key = "country", Type = FieldType.Select, Options = null }));

        Assert.Contains("no options", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_duplicate_field_key_across_config_and_steps()
    {
        var manifest = Make.Manifest();
        var ex = Rejects(manifest with
        {
            Auth = manifest.Auth with
            {
                Config = [new FieldSpec { Key = "username", Type = FieldType.Text }],
            },
        });

        // inputs arrive as one flat dictionary: a duplicate key means one field silently never reaches the adapter
        Assert.Contains("duplicate field key 'username'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_field_pattern_that_is_not_a_regex()
    {
        // the consumer compiles it client-side; an invalid pattern blocks the whole form
        var ex = Rejects(Make.Manifest().WithFields(
            new FieldSpec { Key = "username", Type = FieldType.Text, Pattern = "^[a-" }));

        Assert.Contains("invalid pattern", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Accepts_a_valid_field_pattern()
    {
        ManifestValidator.Validate(Make.Manifest().WithFields(
            new FieldSpec { Key = "username", Type = FieldType.Text, Pattern = "^.{3,64}$" }));
    }

    // a federated login spans hosts: DUO sends the human to login.digid.nl and back;
    // without both declared the live view stops at the IdP
    [Fact]
    public void Accepts_the_exact_hosts_a_federated_login_spans()
    {
        ManifestValidator.Validate(Make.Manifest() with
        {
            Auth = Make.Manifest().Auth with { LoginOrigins = ["mijn.duo.nl", "login.digid.nl"] },
        });
    }

    // declaring none is legal and pins the stream to wherever the page already is, the stricter rule
    [Fact]
    public void Accepts_a_provider_that_declares_no_login_origins()
    {
        Assert.Empty(Make.Manifest().Auth.LoginOrigins);
        ManifestValidator.Validate(Make.Manifest());
    }

    [Theory]
    [InlineData("*.duo.nl")]
    [InlineData("*")]
    [InlineData("mijn.*.nl")]
    public void Rejects_a_wildcard_host(string origin)
    {
        // the one refusal that is not tidiness: a stream following a login anywhere keeps running after success,
        // a live remote view of an authenticated account
        var ex = Rejects(Make.Manifest() with
        {
            Auth = Make.Manifest().Auth with { LoginOrigins = [origin] },
        });

        Assert.Contains("wildcard", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://mijn.duo.nl")]
    [InlineData("mijn.duo.nl/particulier")]
    [InlineData("http://login.digid.nl/inloggen")]
    public void Rejects_a_host_carrying_a_scheme_or_a_path(string origin)
    {
        // the latch compares bare hosts: a scheme or path never matches, so the stream silently pins to the opening host
        // and stops at the IdP
        Rejects(Make.Manifest() with
        {
            Auth = Make.Manifest().Auth with { LoginOrigins = [origin] },
        });
    }

    [Theory]
    [InlineData("MIJN.DUO.NL")]
    [InlineData(" mijn.duo.nl")]
    [InlineData("mijn.duo.nl ")]
    [InlineData("")]
    [InlineData("   ")]
    public void Rejects_a_host_that_would_not_compare_equal(string origin)
    {
        Rejects(Make.Manifest() with
        {
            Auth = Make.Manifest().Auth with { LoginOrigins = [origin] },
        });
    }

    // opposite list: DUO names login.digid.nl in both; the stream must follow to DigiD, but the profile must not bring DigiD's
    // session home, because DUO's SAML request carries ForceAuthn=true and that session cannot save an authentication
    [Fact]
    public void Accepts_the_identity_provider_whose_session_is_not_worth_keeping()
    {
        ManifestValidator.Validate(Make.Manifest() with
        {
            Auth = Make.Manifest().Auth with
            {
                LoginOrigins = ["mijn.duo.nl", "login.digid.nl"],
                DropsKeptSessionFor = ["login.digid.nl"],
            },
        });
    }

    // declaring none is legal and keeps the whole session
    [Fact]
    public void Accepts_a_provider_that_names_no_session_to_drop()
    {
        Assert.Empty(Make.Manifest().Auth.DropsKeptSessionFor);
        ManifestValidator.Validate(Make.Manifest());
    }

    [Theory]
    [InlineData("*.digid.nl")]
    [InlineData("https://login.digid.nl")]
    [InlineData("login.digid.nl/inloggen")]
    [InlineData("LOGIN.DIGID.NL")]
    [InlineData(" login.digid.nl")]
    [InlineData("")]
    public void Rejects_a_dropped_host_that_is_not_a_bare_lowercase_host(string host)
    {
        // a cookie domain is a bare host: any of these matches no cookie, so the session nobody meant to keep stays kept,
        // with no error
        var ex = Rejects(Make.Manifest() with
        {
            Auth = Make.Manifest().Auth with { DropsKeptSessionFor = [host] },
        });

        // the message names WHICH list, since both go through the same code
        Assert.Contains("drops_kept_session_for", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Jumbo")]
    [InlineData("jumbo_plus")]
    [InlineData("-jumbo")]
    [InlineData("jumbo-")]
    [InlineData("jumbo--plus")]
    [InlineData("")]
    public void Rejects_an_id_that_is_not_kebab_case(string id)
    {
        // the id is a route namespace; anything else changes the URL shape consumers were told to expect
        Rejects(Make.Manifest() with { Id = id });
    }

    [Theory]
    [InlineData("jumbo")]
    [InlineData("mock-store-simple")]
    [InlineData("ah")]
    public void Accepts_a_kebab_case_id(string id)
    {
        ManifestValidator.Validate(Make.Manifest() with { Id = id });
    }

    [Theory]
    [InlineData("nl")]
    [InlineData("NLD")]
    [InlineData("N1")]
    [InlineData("")]
    public void Rejects_a_country_that_is_not_iso_3166_alpha_2(string country)
    {
        Rejects(Make.Manifest() with { Country = country });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    public void Rejects_a_manifest_version_below_one(int version)
    {
        // the version is sealed into every bundle as AAD; zero would make "no version" and "version zero" indistinguishable
        var ex = Rejects(Make.Manifest() with { ManifestVersion = version });

        Assert.Contains("manifest_version", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_provider_that_offers_nothing()
    {
        var ex = Rejects(Make.Manifest() with { Resources = [] });

        Assert.Contains("at least one resource", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_duplicate_resource_id()
    {
        var ex = Rejects(Make.Manifest() with { Resources = [Make.Resource(), Make.Resource()] });

        Assert.Contains("duplicate resource id", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_resource_id_that_is_not_kebab_case()
    {
        Rejects(Make.Manifest() with
        {
            Resources = [Make.Resource() with { Id = "Receipts" }],
        });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Rejects_a_resource_that_can_return_nothing(int maxRecords)
    {
        var ex = Rejects(Make.Manifest() with
        {
            Resources = [Make.Resource() with { MaxRecordsPerFetch = maxRecords }],
        });

        Assert.Contains("max records", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_an_enum_param_that_lists_no_values()
    {
        var ex = Rejects(Make.Manifest() with
        {
            Resources =
            [
                Make.Resource() with
                {
                    Params = [new ParamSpec { Key = "include", Type = ParamType.Enum, Values = null }],
                },
            ],
        });

        Assert.Contains("lists no values", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_param_that_is_both_required_and_internal()
    {
        var ex = Rejects(Make.Manifest() with
        {
            Resources =
            [
                Make.Resource() with
                {
                    Params = [new ParamSpec { Key = "cursor", Type = ParamType.Text, Required = true, Internal = true }],
                },
            ],
        });

        Assert.Contains("required and internal", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_null_manifest()
    {
        Assert.Throws<ArgumentNullException>(() => ManifestValidator.Validate(null!));
    }

    [Fact]
    public void Reports_every_problem_at_once()
    {
        // stopping at the first error makes fixing a manifest a guessing game
        var ex = Rejects(Make.Manifest() with
        {
            Id = "Jumbo",
            Country = "nl",
            ManifestVersion = 0,
            Resources = [],
        });

        Assert.Contains("Jumbo", ex.Message, StringComparison.Ordinal);
        Assert.Contains("nl", ex.Message, StringComparison.Ordinal);
        Assert.Contains("manifest_version", ex.Message, StringComparison.Ordinal);
        Assert.Contains("at least one resource", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Names_the_provider_it_refused()
    {
        var ex = Rejects(Make.Manifest() with { ManifestVersion = 0 });

        Assert.Contains("'mock-provider'", ex.Message, StringComparison.Ordinal);
    }
}
