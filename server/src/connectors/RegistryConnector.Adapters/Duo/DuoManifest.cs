using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

using RegistryConnector.Adapters.Support;

namespace RegistryConnector.Adapters.Duo;

internal static class DuoManifest
{
    // 2: bundles are bound to (provider, subject, manifest_version) so a changed login cannot apply to older material.
    // v1 connections sign in again
    public const int Version = 2;

    // 15 minutes of inactivity, confirmed 2026-08-11 from DUO's session-timeout header (900, 868, 852, reset by each request)
    // 900 is the honest floor for an idle connection; a fetch that starts in time cannot time out halfway
    public const int SessionTtlSeconds = 900;

    public static ProviderManifest Build() => new()
    {
        Id = DuoAdapter.ProviderId,
        Name = "DUO",
        Kind = ProviderKind.Registry,
        Country = "NL",
        ManifestVersion = Version,

        // T3: DigiD is a browser login nothing can replace, but no browser need stay open once the cookies exist
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            // a browser cannot run in the control plane's process
            Required = true,

            // pooled by owner decision (was Byo): Logius misuse detection scores IP, failed logins and BSN; a clean browser keeps the IP
            // today's fleet is one household's own container on its own egress, so Byo only cost them (2026-09-21)
            // a datacenter fleet for several households: back to Byo, or gate on ConnectorOptions.IsProduction
            Class = AgentClass.Pooled,

            // what DUO wants of whichever machine takes the job: a Dutch residential address; unenforced, only the agent's claim
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },

        // false, confirmed: DUO's SAML request carries ForceAuthn=true, so DigiD re-authenticates every time
        UnattendedFetch = false,

        // the person has a phone, not a keyboard at the agent: an sms arrives there and the app path relays a QR to it
        LoginNeedsHeadedAgent = false,

        // true from version 2 (v1's remote_browser flow allowed no fields); SecretCustody.Client stays; DigiD still texts a code
        // both fields stay optional: storing nothing is still supported
        OffersCredentialStore = true,

        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "duo",
        NotesKey = MessageKeys.DuoNotes,

        Auth = new AuthSpec
        {
            Flow = AuthFlow.PasswordSms,

            Config =
            [
                // which DigiD method to drive, only on the typed path (else the human picks); sms default: finishes on the machine at hand
                new FieldSpec
                {
                    Key = "method",
                    Type = FieldType.Select,
                    Required = false,
                    Options = ["sms", "app"],
                    LabelKey = MessageKeys.DuoMethod,
                },
            ],

            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = MessageKeys.StepCredentials,

                    // both optional: nothing streams DigiD's own page from its first screen, username+password types them and asks only the code
                    // required fields would make the cautious first connect impossible
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Required = false,
                            LabelKey = MessageKeys.DuoUsername,
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = MessageKeys.DuoPassword,
                        },
                    ],
                },
            ],

            // LiveView carries the sign-in; QrDisplay relays DigiD's inline PNG QR (a photographed one is sometimes unreadable).
            // MfaCode is the typed path's code
            Challenges = [ChallengeType.MfaCode, ChallengeType.LiveView, ChallengeType.QrDisplay],

            // the hosts a sign-in spans: otherwise the live view stays pinned to mijn.duo.nl and stops when the frame moves to DigiD
            // exactly two, no wildcard: *.duo.nl would keep the camera on an authenticated account, and the validator refuses it
            LoginOrigins = ["mijn.duo.nl", "login.digid.nl"],

            // login.digid.nl dropped from the kept session: ForceAuthn makes a restored DigiD session useless, it only changes the page
            // the typed sign-in meets (measured 2026-09-28)
            // mijn.duo.nl must NOT be listed: its cookies let a profile still inside DUO ask nothing
            DropsKeptSessionFor = ["login.digid.nl"],

            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,

                // ForceAuthn meets even a renewable session on the next sign-in
                Refreshable = false,
                RotatesOnUse = false,
            },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },

        Resources =
        [
            new ResourceSpec
            {
                Id = DuoAdapter.DebtResource,
                Returns = ResourceShape.StudentDebt,

                // no since/until: DUO states what is owed now
                // ledger costs a request to the customer dossier, so a caller must choose it; everything else is identity-free
                Params =
                [
                    new ParamSpec
                    {
                        Key = ResourceRequest.IncludeParam,
                        Type = ParamType.Enum,
                        Required = false,
                        Multi = true,
                        Values = [ResourceRequest.LedgerInclude, ResourceRequest.RawInclude],
                    },
                ],

                // one record: a person has one student debt, published as component amounts
                MaxRecordsPerFetch = 1,

                TypicalDurationSeconds = 15,
            },
        ],

        // an hour: stops a consumer's retry loop becoming a request loop; ForceAuthn is what protects DUO
        Limits = new ProviderLimits { MinIntervalSeconds = 3_600, Concurrency = 1 },
    };
}
