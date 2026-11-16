using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Ing;

// captured 2026-08-12 in NL and EN. The CSV export is not the route: ING builds it from a blob: URL, and its derived
// id changed for all 926 rows between languages, where the API's per-transaction id does not
// CAMT.053 is not the route either: ING serves it to business customers only
internal static class IngManifest
{
    public const int Version = 1;

    /// a copy key, never prose: the connector cannot know the reader's language; names the second factor on every
    /// sign-in and the sign-out when finished
    public const string NotesKey = "connect.ing.notes.sca_every_login";

    public const string AppApprovalKey = "connect.ing.challenge.app_approval";

    public static ProviderManifest Build() => new()
    {
        Id = IngAdapter.ProviderId,
        Name = "ING",
        Kind = ProviderKind.Bank,
        // only mijn.ing.nl has been read: one country, not a continent
        Country = "NL",
        ManifestVersion = Version,
        // the browser is used beyond login: pages are read through the signed-in page's fetch, since the session is a
        // cookie jar and the agreement id in the URL belongs to the page
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // NO DesktopBrowser on purpose: the agent emulates a Pixel 5 as the capture did (senderref=MOBIEL in cursor links),
            // and the desktop viewport serves a different first screen
            Egress = new EgressRequirement { Country = "NL", Kind = "any" },
        },
        // false: a second factor on every sign-in, no remembered-device path, a push to the phone each time
        UnattendedFetch = false,
        // the approval happens on the phone; the challenge relay carries it to wherever the person is
        LoginNeedsHeadedAgent = false,
        // SESSION: ING's fraud detection flags accounts that sign in and never sign out, and signing out is the only way
        // to end a session that cannot be renewed
        Logout = LogoutSupport.Session,
        // sealed username and password stay on the person's device (#543): every sync is a sign-in, and only they can do the push
        OffersCredentialStore = true,
        SecretCustody = SecretCustody.Client,
        // Ephemeral, not None: the platform refuses a web session for a provider declaring None, and a full sign-in per
        // visit is the same deal DUO and BKR ship
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "ing",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // credentials, then approval in the app: POST /username-password/open/authenticate, then a push session polled until READY
            Flow = AuthFlow.MobileApproval,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = "connect.ing.step.credentials",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Secret = false,
                            Required = true,
                            LabelKey = "connect.field.username",
                            Autofill = "username",
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            // redaction keys off this flag and the validator refuses the manifest without it
                            Secret = true,
                            Required = true,
                            LabelKey = "connect.field.password",
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // QR code and TAN/PAC device are offered but not declared: neither was carried through to a finished session in the capture
            Challenges = [ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                // 15 minutes, no refresh: ING refreshes only while a browser sits on the page (POST /api/sessions/refresh), and
                // keeping it warm would mean an agent running continuously against a bank
                TtlSeconds = 900,
                Refreshable = false,
                RotatesOnUse = false,
            },
            // reauth is the whole login (password and phone): a cheap flag would invite scheduled retries against a bank
            // that counts failures
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            BankResources.AccountsSpec(),
            // 300s is a first connect walking cursor pages of forty; 2000 rows exceeds the 540 days ING keeps (a first sync
            // reaches as far back as the party allows)
            BankResources.TransactionsSpec(
                maxHistoryDays: MaxHistoryDays,
                typicalDurationSeconds: 300,
                maxRecordsPerFetch: 2_000),
        ],
        Limits = BankLimits.ForBank(maxHistoryDays: MaxHistoryDays) with
        {
            // a stated preference, no bank publishes a threshold: a first connect walking twenty pages must not arrive as a burst
            MinRequestGapMs = 750,
        },
    };

    /// 540 days is BankResources' default, NOT established by the capture; it CLAMPS the caller's since, so a guess
    /// would make older transactions look nonexistent, and the page walk stops on ING's last cursor anyway
    private const int MaxHistoryDays = 540;
}
