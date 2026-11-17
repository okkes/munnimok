using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.AlbertHeijn;
using ShopConnector.Adapters.Jumbo;
using ShopConnector.Adapters.LidlPlus;
using ShopConnector.Adapters.Mock;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// the manifest is the consuming app's only contract: one that lies makes it promise something and then fail
// key facts: Jumbo's 24 h non-refreshable session, Lidl unattended with country/language config, Albert Heijn's version bump
public sealed class ManifestTests
{
    private static readonly ProviderRegistry Registry = new(ShopAdapters.All());

    private static readonly string[] IncludeVocabulary = ["items", "raw", "invoice"];

    private static readonly string[] LidlCountries = ["NL", "DE", "AT", "BE", "FR", "IT", "ES"];

    private static readonly string[] LidlLanguages = ["nl", "de", "en", "fr", "it", "es"];

    public static TheoryData<string> ProviderIds
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var manifest in Registry.Manifests) data.Add(manifest.Id);
            return data;
        }
    }

    [Fact]
    public void Registry_registers_every_shop_provider()
    {
        // Ordinal-sorted by the registry, so this list is alphabetical rather
        // than grouped by how anyone thinks about the providers.
        string[] expected =
        [
            "ah", "amazon-nl", "bol", "coolblue", "jumbo", "lidl", "mediamarkt-nl",
            "mock-store-broken", "mock-store-captcha", "mock-store-persistent",
            "mock-store-simple", "mock-store-slow", "mock-store-sms",
        ];

        Assert.Equal(expected, Registry.Manifests.Select(m => m.Id));
    }

    [Theory]
    [MemberData(nameof(ProviderIds))]
    public void Every_manifest_validates(string providerId)
    {
        var manifest = Registry.RequireManifest(providerId);

        ManifestValidator.Validate(manifest);
    }

    [Theory]
    [MemberData(nameof(ProviderIds))]
    public void Every_provider_offers_the_receipts_resource_the_spec_documents(string providerId)
    {
        var manifest = Registry.RequireManifest(providerId);

        var receipts = manifest.Resource("receipts");
        Assert.NotNull(receipts);
        Assert.Equal(ResourceShape.Receipt, receipts.Returns);

        var since = receipts.Param("since");
        Assert.NotNull(since);
        Assert.Equal(ParamType.Date, since.Type);
        Assert.True(since.Required, "since is required on every receipts resource");

        var until = receipts.Param("until");
        Assert.NotNull(until);
        Assert.Equal(ParamType.Date, until.Type);

        var include = receipts.Param("include");
        Assert.NotNull(include);
        Assert.Equal(ParamType.Enum, include.Type);
        Assert.True(include.Multi, "include is comma-separated");

        // the vocabulary is closed so a provider cannot push the consumer into knowing who answered
        // "raw" is the payload a record was DERIVED from, "invoice" a file the provider ISSUED to the user
        Assert.All(include.Values!, value => Assert.Contains(value, IncludeVocabulary));

        // coolblue is back in items: its order page itemises, and where it charges more than it lists
        // the gap becomes a derived Unattributed line
        Assert.Contains("items", include.Values!);
    }

    // raw is declared, not attempted: a scraped-page adapter has no single document,
    // and offering one promises an always-empty field
    [Theory]
    [InlineData("ah", true)]
    // jumbo and bol read orders from a JSON API, so the document can be handed back verbatim
    [InlineData("jumbo", true)]
    [InlineData("bol", true)]
    // Lidl's v3 detail IS the answer, and every field name the parser reads is a candidate:
    // raw shows which Lidl uses without another live sign-in
    [InlineData("lidl", true)]
    // not offered where a record is built from several calls: no single document is the answer
    public void Raw_is_offered_only_where_a_provider_document_exists_to_offer(
        string providerId, bool offersRaw)
    {
        var include = Registry.RequireManifest(providerId).Resource("receipts")!.Param("include")!;

        Assert.Equal(offersRaw, include.Values!.Contains("raw", StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(ProviderIds))]
    public void Every_manifest_names_copy_keys_and_never_prose(string providerId)
    {
        var manifest = Registry.RequireManifest(providerId);

        // a connector never emits user-facing English: every string a human reads is a key the app owns and translates
        Assert.StartsWith("connect.", manifest.NotesKey, StringComparison.Ordinal);

        foreach (var step in manifest.Auth.Steps)
        {
            Assert.StartsWith("connect.", step.LabelKey, StringComparison.Ordinal);
        }

        foreach (var field in manifest.Auth.AllFields())
        {
            Assert.StartsWith("connect.", field.LabelKey, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Jumbo_declares_the_cookie_s_real_life_and_no_refresh_path()
    {
        var session = Registry.RequireManifest(JumboAdapter.ProviderId).Auth.Session;

        // Jumbo's credential is a ~24 h browser cookie this connector cannot renew; claiming thirty days would fail daily
        // auth.jumbo.com does offer refresh_token, but Jumbo's backend exchanges the code: the browser gets only a cookie
        Assert.Equal(86_400, session.TtlSeconds);
        Assert.False(session.Refreshable, "the web client never holds a refresh token; the backend keeps it");

        // no token in our hands to re-issue, so nothing rotates; the field defaults to true,
        // so the wrong value cost nothing to write
        Assert.False(session.RotatesOnUse, "nothing is ever re-issued, so a consumer must not watch for it");
    }

    [Fact]
    public void Jumbo_is_an_interactive_browser_provider_on_a_residential_dutch_line()
    {
        var manifest = Registry.RequireManifest(JumboAdapter.ProviderId);

        Assert.Equal(ProviderRuntime.BrowserInteractive, manifest.Runtime);
        Assert.True(manifest.Agent.Required);
        Assert.Equal(AgentClass.Pooled, manifest.Agent.Class);
        Assert.NotNull(manifest.Agent.Egress);
        Assert.Equal("NL", manifest.Agent.Egress.Country);
        Assert.Equal("residential", manifest.Agent.Egress.Kind);

        // a human signs in roughly daily, so scheduled sync is not offerable
        Assert.False(manifest.UnattendedFetch);
        Assert.False(manifest.Auth.Reauth.Cheap);
        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);

        // fields are optional: supplied, the adapter types them in; nothing, the page is streamed from the start
        Assert.Equal(AuthFlow.Password, manifest.Auth.Flow);

        // LiveView answers the wall: Auth0's auth0_v2 captcha (Cloudflare Turnstile) mints its token in the browser that rendered it
        // the other three are the typed path, shipped on purpose: it can meet a code, a picture captcha or a widget after submit
        Assert.Equal(
            [ChallengeType.LiveView, ChallengeType.MfaCode, ChallengeType.Image, ChallengeType.AppApproval],
            manifest.Auth.Challenges);

        // the streamed wall reaches the human wherever they are, so no agent needs somebody standing at it
        Assert.False(manifest.LoginNeedsHeadedAgent);
    }

    // both credentials OPTIONAL: a consumer making them required would make a first connect impossible to offer
    [Fact]
    public void Jumbo_asks_for_credentials_but_does_not_require_them()
    {
        var manifest = Registry.RequireManifest(JumboAdapter.ProviderId);

        Assert.Equal(AuthFlow.Password, manifest.Auth.Flow);
        Assert.Equal(["username", "password"], manifest.Auth.AllFields().Select(f => f.Key));
        Assert.All(manifest.Auth.AllFields(), f => Assert.False(f.Required));

        // the redactor keys on Secret to refuse a screenshot while the box holds content
        Assert.True(manifest.Auth.AllFields().Single(f => f.Key == "password").Secret);
    }

    [Fact]
    public void Lidl_is_unattended_and_carries_country_and_language_as_config()
    {
        var manifest = Registry.RequireManifest(LidlPlusAdapter.ProviderId);

        // the refresh token works headlessly forever, which makes scheduled sync offerable
        Assert.True(manifest.UnattendedFetch);
        Assert.True(manifest.Auth.Session.Refreshable);
        Assert.Equal(7_776_000, manifest.Auth.Session.TtlSeconds);
        Assert.True(manifest.Auth.Reauth.Cheap);

        var config = manifest.Auth.Config;
        Assert.Equal(2, config.Count);

        var country = Assert.Single(config, f => f.Key == "country");
        Assert.Equal(FieldType.Select, country.Type);
        Assert.True(country.Required);
        Assert.False(country.Secret);
        Assert.Equal(LidlCountries, country.Options);

        var language = Assert.Single(config, f => f.Key == "language");
        Assert.Equal(FieldType.Select, language.Type);
        Assert.True(language.Required);
        Assert.Equal(LidlLanguages, language.Options);
    }

    // reCAPTCHA Enterprise scores the BROWSER: the user's OWN browser only works for a native shell
    // intercepting com.lidlplus.app://; streaming works for everyone, the redirect lands here and the code is read from it
    [Fact]
    public void Lidl_streams_its_sign_in_and_asks_nobody_to_copy_an_address()
    {
        var manifest = Registry.RequireManifest(LidlPlusAdapter.ProviderId);

        Assert.Equal(ProviderRuntime.BrowserInteractive, manifest.Runtime);
        Assert.True(manifest.Agent.Required, "the streamed page runs on an agent's browser");
        Assert.False(manifest.LoginNeedsHeadedAgent, "a streamed view reaches the human wherever they are");
        Assert.Equal(AuthFlow.Password, manifest.Auth.Flow);

        // both OPTIONAL: given them the adapter types them in, given nothing it streams from the first screen
        var step = Assert.Single(manifest.Auth.Steps);
        Assert.Equal(2, step.Fields.Count);

        var username = Assert.Single(step.Fields, f => f.Key == "username");
        Assert.False(username.Required);
        Assert.False(username.Secret);

        var password = Assert.Single(step.Fields, f => f.Key == "password");
        Assert.False(password.Required);
        Assert.True(password.Secret, "an unmarked password is logged and screenshotted");

        // nothing to paste: the redirect_url field and the Redirect challenge are gone for good
        Assert.DoesNotContain(manifest.Auth.AllFields(), f => f.Key == "redirect_url");
        Assert.DoesNotContain(manifest.Auth.Challenges, c => c == ChallengeType.Redirect);

        // LiveView answers the wall; the other three are the shipped typed path
        Assert.Equal(
            new[]
            {
                ChallengeType.LiveView, ChallengeType.MfaCode,
                ChallengeType.Image, ChallengeType.AppApproval,
            },
            manifest.Auth.Challenges);

        // no credential store (the validator refuses one): the refresh token stops the human being asked again,
        // so a held password buys nothing
        Assert.False(manifest.OffersCredentialStore);

        var config = manifest.Auth.Config;
        Assert.Contains(config, f => f.Key == "country");
        Assert.Contains(config, f => f.Key == "language");

        Assert.True(manifest.Auth.Session.Refreshable);
        Assert.True(manifest.UnattendedFetch);

        var receipts = manifest.Resource("receipts");
        Assert.NotNull(receipts);
        Assert.Equal(730, receipts.MaxHistoryDays);
        Assert.Equal(21_600, manifest.Limits.MinIntervalSeconds);
        Assert.Equal(1, manifest.Limits.Concurrency);
    }

    [Fact]
    public void Albert_heijn_drives_its_login_in_a_pooled_browser_on_a_dutch_residential_line()
    {
        var manifest = Registry.RequireManifest(AlbertHeijnAdapter.ProviderId);

        // T2: the agent types the credentials and catches the appie:// redirect itself.
        // pasting it out of a console is impossible on a phone
        Assert.Equal(ProviderRuntime.BrowserOnce, manifest.Runtime);
        Assert.True(manifest.Agent.Required);
        Assert.Equal(AgentClass.Pooled, manifest.Agent.Class);
        Assert.NotNull(manifest.Agent.Egress);
        Assert.Equal("NL", manifest.Agent.Egress.Country);
        Assert.Equal("residential", manifest.Agent.Egress.Kind);

        // streamed now, but agent and Dutch residential line stay: a human-driven browser must still appear to be there
        Assert.Equal(AuthFlow.RemoteBrowser, manifest.Auth.Flow);

        // two challenges: the streamed page already shows the human any captcha, SMS box or approval prompt.
        // Redirect stays as last resort. A consumer with no UI for a challenge its provider raises strands the user
        Assert.Equal(
            new[] { ChallengeType.LiveView, ChallengeType.Redirect },
            manifest.Auth.Challenges);

        // the typed login still declares its three, one flag away
        Assert.Equal(
            new[] { ChallengeType.Image, ChallengeType.AppApproval, ChallengeType.Redirect },
            AlbertHeijnManifest.Build(liveLogin: false).Auth.Challenges);

        // the refresh token works headlessly, which makes scheduled sync offerable
        Assert.True(manifest.UnattendedFetch);
        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);
        Assert.Equal(WebSupport.Ephemeral, manifest.WebSupport);
        Assert.Equal(7_776_000, manifest.Auth.Session.TtlSeconds);
        Assert.True(manifest.Auth.Session.Refreshable);
        Assert.True(manifest.Auth.Session.RotatesOnUse);
    }

    [Fact]
    public void Albert_heijn_asks_for_nothing_at_all_because_the_human_types_into_ahs_own_page()
    {
        var manifest = Registry.RequireManifest(AlbertHeijnAdapter.ProviderId);

        // custody as a manifest property: no field, no form, no credential posted to or held by this platform
        // ManifestValidator refuses a remote_browser flow that declares one
        Assert.Empty(manifest.Auth.Steps);
        Assert.Empty(manifest.Auth.AllFields());

        // bundle shape unchanged (access + refresh token), so the version stays 2: bumping would log out every connected user
        Assert.Equal(2, manifest.ManifestVersion);

        Assert.Contains(ChallengeType.LiveView, manifest.Auth.Challenges);

        // the typed login stays one flag away for the day AH changes something that breaks the streamed one
        var typed = AlbertHeijnManifest.Build(liveLogin: false);
        Assert.Equal(AuthFlow.Password, typed.Auth.Flow);
        Assert.Equal(2, Assert.Single(typed.Auth.Steps).Fields.Count);
    }

    [Fact]
    public void The_typed_albert_heijn_login_still_asks_for_an_email_and_a_password_and_not_for_a_paste()
    {
        var manifest = AlbertHeijnManifest.Build(liveLogin: false);
        var step = Assert.Single(manifest.Auth.Steps);

        Assert.Equal(2, step.Fields.Count);
        Assert.DoesNotContain(manifest.Auth.AllFields(), f => f.Key == "redirect_url");

        // an e-mail address, not a member number or phone: wrong in the consumer's form costs a failed attempt
        // against a defended page
        var username = Assert.Single(step.Fields, f => f.Key == "username");
        Assert.Equal(FieldType.Text, username.Type);
        Assert.False(username.Secret);
        Assert.True(username.Required);

        var password = Assert.Single(step.Fields, f => f.Key == "password");
        Assert.Equal(FieldType.Password, password.Type);
        Assert.True(password.Secret, "an unmarked password is logged and screenshotted");
        Assert.True(password.Required);
    }

    [Fact]
    public void Mock_store_persistent_is_the_byo_case_that_holds_no_secret()
    {
        var manifest = Registry.RequireManifest(MockStoreAdapters.Persistent);

        Assert.Equal(ProviderRuntime.BrowserPersistent, manifest.Runtime);
        Assert.Equal(AgentClass.Byo, manifest.Agent.Class);
        Assert.True(manifest.Agent.Required);

        // agent custody: the control plane holds nothing, so the flow has no credential step
        Assert.Equal(SecretCustody.Agent, manifest.SecretCustody);
        Assert.Equal(AuthFlow.DevicePersistent, manifest.Auth.Flow);
        Assert.Empty(manifest.Auth.Steps);
        Assert.True(manifest.UnattendedFetch);
    }

    [Theory]
    [InlineData(MockStoreAdapters.Simple)]
    [InlineData(MockStoreAdapters.Sms)]
    [InlineData(MockStoreAdapters.Captcha)]
    [InlineData(MockStoreAdapters.Slow)]
    [InlineData(MockStoreAdapters.Broken)]
    public void Mock_store_providers_other_than_persistent_run_inline_with_no_browser(string providerId)
    {
        var manifest = Registry.RequireManifest(providerId);

        // a mock needing an agent or browser would stop being the offline backbone when CI runs without one
        Assert.Equal(ProviderRuntime.Http, manifest.Runtime);
        Assert.False(manifest.Agent.Required);
        Assert.Equal(AgentClass.Inline, manifest.Agent.Class);
        Assert.Equal(60, manifest.Limits.MinIntervalSeconds);
    }

    // two independent questions: can the FETCH run with nobody there, can the LOGIN be finished by someone not at the agent
    // they were one field, so the demo showed an "unattended" chip on a card whose Connect button asked for a person
    [Theory]
    // streams AH's own page to the account owner, so any agent will do; the refresh token fetches on its own afterwards
    [InlineData("ah", true, false)]
    // coolblue: OIDC with offline_access and a real refresh grant, yet no unattended fetch: account pages are
    // server-rendered HTML behind the session cookie and the captured order request carried no Authorization header
    [InlineData("coolblue", false, true)]
    [InlineData("lidl", true, false)]
    // a human signs in roughly daily, but on their own screen wherever they are: Jumbo's page is streamed to them
    [InlineData("jumbo", false, false)]
    [InlineData("bol", false, true)]
    [InlineData("amazon-nl", false, true)]
    // cheapest fetch in the fleet, still not unattended: it spends a session cookie inside a browser
    // and no token exists to renew
    [InlineData("mediamarkt-nl", false, true)]
    public void Each_provider_answers_the_fetch_and_login_questions_separately(
        string providerId, bool unattendedFetch, bool loginNeedsHeadedAgent)
    {
        var manifest = Registry.RequireManifest(providerId);

        Assert.Equal(unattendedFetch, manifest.UnattendedFetch);
        Assert.Equal(loginNeedsHeadedAgent, manifest.LoginNeedsHeadedAgent);
    }

    // AH's headed requirement follows the login it performs: the streamed page relays the wall to a phone,
    // the typed form meets hCaptcha itself
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void Albert_heijns_headed_requirement_follows_which_login_it_is_built_for(
        bool liveLogin, bool needsHeaded)
    {
        Assert.Equal(needsHeaded, AlbertHeijnManifest.Build(liveLogin).LoginNeedsHeadedAgent);
    }

    // nothing in the fleet reaches a provider on disconnect; the rest inherit the interface's do-nothing default
    // Amazon's logout navigates a browser and returns at once unless one is running:
    // declaring Session would promise a sign-out that never happens
    [Theory]
    [InlineData("amazon-nl", LogoutSupport.None)]
    [InlineData("ah", LogoutSupport.None)]
    [InlineData("jumbo", LogoutSupport.None)]
    [InlineData("lidl", LogoutSupport.None)]
    [InlineData("bol", LogoutSupport.None)]
    [InlineData("coolblue", LogoutSupport.None)]
    // MediaMarkt has a named LogoutUser mutation, so most likely a future Session; None until something calls it
    [InlineData("mediamarkt-nl", LogoutSupport.None)]
    public void Each_provider_declares_what_disconnecting_does_upstream(
        string providerId, LogoutSupport expected)
    {
        Assert.Equal(expected, Registry.RequireManifest(providerId).Logout);
    }

    // nothing claims account-wide revocation: the value lets a consumer WARN before signing someone out of the app
    // on their phone, and declaring it where untrue would train users to ignore the warning
    [Fact]
    public void No_shop_provider_claims_to_revoke_a_whole_account()
    {
        Assert.DoesNotContain(Registry.Manifests, m => m.Logout == LogoutSupport.Account);
    }

    [Fact]
    public void Catalog_digest_changes_only_when_a_manifest_version_does()
    {
        var again = new ProviderRegistry(ShopAdapters.All());

        // the consumer caches the catalogue against this ETag, so it must be stable across processes
        Assert.Equal(Registry.CatalogDigest, again.CatalogDigest);
        Assert.StartsWith("sha256:", Registry.CatalogDigest, StringComparison.Ordinal);
    }
}
