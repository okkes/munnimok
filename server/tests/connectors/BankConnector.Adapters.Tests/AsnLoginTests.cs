using BankConnector.Adapters.Asn;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Xunit;

namespace BankConnector.Adapters.Tests;

// ASN's catalogue entries and the options an adapter was written from; the old login-flow tests went when
// discovery sessions contradicted the design document (see AsnAdapterTests)
public sealed class AsnLoginTests
{
    // the discovery run relays the bank's own page, which only LiveView does: it once declared app_approval and
    // rendered a passive panel with no stream
    [Fact]
    public void The_discovery_run_offers_the_one_challenge_that_relays_a_page()
    {
        var manifest = AsnDiscoveryManifest.Build();

        Assert.Equal([ChallengeType.LiveView], manifest.Auth.Challenges);

        // no fields: the run types nothing, a form would collect a credential it has no use for
        Assert.Empty(Assert.Single(manifest.Auth.Steps).Fields);

        // the live view makes the browser's location irrelevant: demanding a headed agent would pin the run to one machine
        Assert.False(manifest.LoginNeedsHeadedAgent);
    }

    // asn-persistent waited on an objection (built against unwalked screens) that is spent: the pooled adapter has
    // walked every screen live. Still unmeasured: whether ASN's session survives in a persistent profile, so the
    // adapter asks (AsnPersistentAdapterTests)
    [Fact]
    public void Both_asn_tiers_are_reachable_and_the_discovery_run_is_not()
    {
        var registered = BankAdapters.All().Select(a => a.Describe().Id).ToList();

        Assert.Contains(AsnManifest.ProviderId, registered);
        Assert.Contains(AsnPersistentManifest.ProviderId, registered);

        // the discovery run is not a provider: it connects to and fetches nothing, so listing it offers a connection
        // nobody can make
        Assert.DoesNotContain(AsnDiscoveryAdapter.ProviderId, registered);
    }

    // the manifest once demanded a digipas serial (from a design document; ASN stopped issuing them, the adapter never
    // read it) and the form refused to submit. A manifest validates against its own rules, not the adapter: a field
    // on this form must be one the adapter uses
    [Fact]
    public void The_sign_in_form_asks_for_nothing_and_the_challenge_is_a_code_to_scan()
    {
        var manifest = AsnManifest.Build();

        Assert.Equal(AuthFlow.QrScan, manifest.Auth.Flow);
        Assert.Empty(Assert.Single(manifest.Auth.Steps).Fields);
        // LiveView, not QrDisplay: ASN refreshes its code every few seconds, so a still would have expired
        Assert.Equal([ChallengeType.LiveView], manifest.Auth.Challenges);
    }

    // the manifests stay validated so the day ASN is registered is not the first day they are
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Both_manifests_satisfy_the_platforms_own_validator(bool persistent)
    {
        var manifest = persistent ? AsnPersistentManifest.Build() : AsnManifest.Build();

        ManifestValidator.Validate(manifest);
    }

    // pins the values a second discovery run would cost to re-establish: the reasoned login address 404'd; every input
    // is input[data-testid='input'] (names the component), so only [type=] tells username from password
    [Fact]
    public void The_options_carry_what_the_session_observed()
    {
        var options = new AsnOptions();

        Assert.Equal(
            "https://www.asnbank.nl/online/web/onlinebankieren/inloggen/", options.LoginUrl);

        Assert.Equal(
            "/online/web/onlinebankieren/zelf-regelen/transacties-downloaden", options.ExportPath);

        Assert.All(
            new[] { options.UsernameSelectors, options.PasswordSelectors },
            selectors => Assert.All(
                selectors,
                s => Assert.Contains("[type=", s, StringComparison.Ordinal)));

        // the QR has no handle, so it is found by geometry: an svg beside an svg logo, 205x205 against 158x30
        Assert.True(options.QrMinimumPixels is > 100 and < 205);
    }
}
