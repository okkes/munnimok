using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Asn;

/// Separate from AsnManifest so nothing has to pretend: it connects to nothing, fetches nothing, declares no fields.
internal static class AsnDiscoveryManifest
{
    public const int Version = 1;

    public const string NotesKey = "connect.asn.notes.discovery";

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

        // false: the live view streams the agent's browser to the driver's own screen, so no headed agent is needed
        LoginNeedsHeadedAgent = false,

        Logout = LogoutSupport.None,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "asn",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.ChallengeResponse,

            // no fields: this run types nothing, so a serial-number form would collect a credential it has no use for
            Steps = [new AuthStep { Id = "watch", LabelKey = "connect.asn.step.watch", Fields = [] }],

            // LiveView only: AppApproval rendered as a passive panel with no stream, since a live view is not a question
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec { TtlSeconds = 900, Refreshable = false, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },

        // one resource because the platform requires it; unreachable: the login always refuses and hands back no bundle
        Resources = [BankResources.AccountsSpec()],
        Limits = BankLimits.ForBank(maxHistoryDays: 1),
    };
}
