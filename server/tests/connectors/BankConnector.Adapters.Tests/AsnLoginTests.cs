using BankConnector.Adapters.Asn;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// ASN's catalogue entries and the options an adapter was written from.
///
/// <para>
/// <b>These used to test a login flow, and that flow has been deleted.</b> It
/// was written from a design document - a digipas serial typed into a form,
/// then a challenge number read back - and a discovery session on 2026-08-17
/// showed a different bank: a cookie wall in front of everything, three login
/// methods chosen by their own product names, no serial field on either path
/// anybody uses, and a QR that is an unlabelled <c>svg</c> told apart from the
/// logo by being square.
/// </para>
///
/// <para>
/// Tests that assert a flow the evidence contradicts are worse than no tests,
/// because they are green. So they went with it, and the adapter was rewritten
/// from what two sessions actually showed - see AsnAdapterTests, which drives
/// it. What is left here is everything around it: that the manifests validate,
/// that the persistent variant is still not reachable, that the discovery run
/// relays a page, and that the options still say what was seen.
/// </para>
/// </summary>
public sealed class AsnLoginTests
{
    /// <summary>
    /// THE DISCOVERY RUN RELAYS THE BANK'S OWN PAGE, and only one challenge
    /// type does that.
    /// </summary>
    /// <remarks>
    /// This shipped declaring <c>app_approval</c> - four "tell me when you are
    /// there" prompts - and rendered as a passive panel with a button and no
    /// stream at all, because a live view is not a question with an answer. It
    /// is a conversation: pictures out many times a second, pointer and key
    /// events back.
    /// <para>
    /// Nothing caught it. The manifest validated, the suite was green, and the
    /// failure was a person looking at a page where their bank should have
    /// been.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_discovery_run_offers_the_one_challenge_that_relays_a_page()
    {
        var manifest = AsnDiscoveryManifest.Build();

        Assert.Equal([ChallengeType.LiveView], manifest.Auth.Challenges);

        // And it asks for nothing, because it types nothing. A form here would
        // be collecting a credential the run has no use for.
        Assert.Empty(Assert.Single(manifest.Auth.Steps).Fields);

        // The live view is what makes the browser's location irrelevant: the
        // page is streamed to whoever is driving it. Demanding a headed agent
        // would pin this to the one machine it never needed to run on.
        Assert.False(manifest.LoginNeedsHeadedAgent);
    }

    /// <summary>
    /// BOTH ASN TIERS ARE REACHABLE; THE DISCOVERY RUN IS NOT.
    /// </summary>
    /// <remarks>
    /// The pooled adapter was written from two discovery sessions and earned
    /// its place. <c>asn-persistent</c> waited on a stated objection - that a
    /// permanently authenticated bank session built against screens nobody had
    /// driven is the worst available combination of consequential and
    /// unverified - and that objection is spent: every screen it drives has
    /// since been walked on a live account by the pooled adapter it composes.
    /// <para>
    /// What remains unmeasured is whether ASN's session survives in a
    /// persistent profile, and the adapter asks rather than assumes - see
    /// <c>AsnPersistentAdapterTests</c>, where a profile that is not signed in
    /// fails its fetch honestly instead of reporting a bank that has changed.
    /// </para>
    /// </remarks>
    [Fact]
    public void Both_asn_tiers_are_reachable_and_the_discovery_run_is_not()
    {
        var registered = BankAdapters.All().Select(a => a.Describe().Id).ToList();

        Assert.Contains(AsnManifest.ProviderId, registered);
        Assert.Contains(AsnPersistentManifest.ProviderId, registered);

        // AND THE DISCOVERY RUN IS NOT A PROVIDER. It connects to nothing and
        // fetches nothing - it opens a bank's sign-in page and describes what
        // each screen is built from - so a catalogue that lists it is offering
        // somebody a connection they cannot make.
        //
        // It was registered for one run on 2026-08-26 and taken back out, which
        // is the procedure BankAdapters describes. That run is where the
        // browsercode flow came from: twenty screens of ASN's browser
        // registration, none of which anybody had seen before.
        Assert.DoesNotContain(AsnDiscoveryAdapter.ProviderId, registered);
    }

    /// <summary>
    /// ASN ASKS FOR NOTHING, because there is nothing to type.
    /// </summary>
    /// <remarks>
    /// This manifest declared <c>challenge_response</c> and demanded an
    /// eight-to-twelve digit digipas serial, marked required with a pattern,
    /// because it was written from a design document describing a card reader.
    /// ASN has stopped issuing those devices - and the adapter never read the
    /// field anyway; it clicks the app and photographs a QR.
    /// <para>
    /// So the connect form asked for a number nobody has and refused to submit
    /// without it: a provider that could not be connected at all, described by
    /// a manifest that was internally consistent and externally wrong. Nothing
    /// caught it, because a manifest validates against its own rules and not
    /// against the adapter that has to honour it.
    /// </para>
    /// <para>
    /// The rule this pins: a field on this provider's form is a field somebody
    /// has to fill in before they can connect, so it had better be one the
    /// adapter uses.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_sign_in_form_asks_for_nothing_and_the_challenge_is_a_code_to_scan()
    {
        var manifest = AsnManifest.Build();

        Assert.Equal(AuthFlow.QrScan, manifest.Auth.Flow);
        Assert.Empty(Assert.Single(manifest.Auth.Steps).Fields);
        // LiveView rather than QrDisplay: ASN refreshes its code every few
        // seconds, so what is relayed has to be the page as it stands rather
        // than a still that has already expired.
        Assert.Equal([ChallengeType.LiveView], manifest.Auth.Challenges);
    }

    /// <summary>
    /// The manifests are still held to every rule the platform enforces, so the
    /// day ASN is registered is not the day its catalogue entry is first
    /// validated.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Both_manifests_satisfy_the_platforms_own_validator(bool persistent)
    {
        var manifest = persistent ? AsnPersistentManifest.Build() : AsnManifest.Build();

        ManifestValidator.Validate(manifest);
    }

    /// <summary>
    /// THE OPTIONS FILE CARRIES WHAT THE SESSION SAW, and this is the test that
    /// notices if somebody quietly reverts it to reasoning.
    /// </summary>
    /// <remarks>
    /// Thin on purpose - it asserts the handful of values a second discovery
    /// run would have to be spent re-establishing. The login address is the one
    /// that already cost a run: the reasoned default 404'd.
    /// <para>
    /// The input selectors are the other lesson worth pinning. Every field on
    /// de Volksbank's pages is <c>input[data-testid='input']</c> - the test id
    /// names the COMPONENT, not the field - so only the type tells the username
    /// from the password, and a selector without one matches whichever box
    /// happens to be first.
    /// </para>
    /// </remarks>
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

        // The QR is found by geometry because it has no handle at all: an svg
        // beside an svg logo, 205x205 against 158x30.
        Assert.True(options.QrMinimumPixels is > 100 and < 205);
    }
}
