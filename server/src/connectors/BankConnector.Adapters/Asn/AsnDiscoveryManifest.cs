using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Asn;

/// <summary>
/// The catalogue entry for the discovery run, and the only ASN entry a
/// consumer can see until the real one works.
///
/// <para>
/// A separate provider rather than a mode on <see cref="AsnManifest"/>, so that
/// nothing has to pretend. This one says what it is - it connects to nothing,
/// fetches nothing, and exists to describe ASN's pages once - and the real
/// adapter stays unregistered until somebody has done exactly that.
/// </para>
///
/// <para>
/// It declares no fields at all, which is the point: a discovery run needs no
/// serial number and no method, because it types nothing. The human signs in
/// through the live view with their own device.
/// </para>
/// </summary>
internal static class AsnDiscoveryManifest
{
    public const int Version = 1;

    /// <summary>
    /// "This does not connect anything. It looks at ASN's pages so the real
    /// connector can be written."
    /// </summary>
    public const string NotesKey = "connect.asn.notes.discovery";

    /// <summary>What the person driving the live view is told.</summary>
    public const string LiveKey = "connect.asn.discover.live";

    public static ProviderManifest Build() => new()
    {
        Id = AsnDiscoveryAdapter.ProviderId,
        Name = "ASN Bank (setting up)",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        UnattendedFetch = false,

        // FALSE, and the live view is exactly why. The agent's browser is
        // streamed to whoever is driving it, so "where they can see it" is
        // their own screen - which is the entire reason that challenge type
        // exists. Declaring a headed agent would restrict this to the one
        // machine it never needed to run on.
        LoginNeedsHeadedAgent = false,

        Logout = LogoutSupport.None,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "asn",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.ChallengeResponse,

            // NO FIELDS. There is nothing to ask for: this run types nothing,
            // so a form asking for a serial number would be collecting a
            // credential it has no use for.
            Steps = [new AuthStep { Id = "watch", LabelKey = "connect.asn.step.watch", Fields = [] }],

            // LiveView, and nothing else. The first cut of this declared
            // AppApproval - four "tell me when you are there" prompts - which
            // rendered as a passive panel with a button and no stream at all,
            // because a live view is not a question with an answer. It is the
            // provider's own page, relayed, with the human driving it.
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec { TtlSeconds = 900, Refreshable = false, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },

        // ONE, AND UNREACHABLE BY CONSTRUCTION.
        //
        // The platform requires every provider to offer something, which is a
        // sound rule - a provider with no resources is a connect card that
        // leads nowhere - and this is the one provider it does not fit. What
        // makes the declaration harmless rather than a lie is that the login
        // REFUSES at the end and hands back no bundle, so no session can ever
        // exist to fetch with and FetchAsync cannot be called. Its throw stays
        // a throw for the same reason: an empty list is a promise, and this
        // makes none.
        Resources = [BankResources.AccountsSpec()],
        Limits = BankLimits.ForBank(maxHistoryDays: 1),
    };
}
