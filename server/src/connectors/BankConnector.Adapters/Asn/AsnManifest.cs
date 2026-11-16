using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Asn;

/// ASN serves CAMT.053 to private customers (ING reserves it for businesses), so Camt053Parser carries the fetch.
/// Facts about asnbank.nl live in AsnOptions; its "edge login" keeping a browser signed in justifies the persistent tier.
internal static class AsnManifest
{
    public const int Version = 1;

    public const string ProviderId = "asn";

    public const string NotesKey = "connect.asn.notes.device_every_login";

    public const string QrKey = "connect.asn.challenge.app_qr";

    /// On the fetch, not the provider: it is a fact about what leaves the bank, and the fetch screen is read every time.
    public const string WholeExportKey = "fetch.asn.notes.whole_export";

    /// NOT established: it clamps a caller's since, so a number from one capture would make older transactions
    /// "not exist"; the export's own range bounds a fetch.
    private const int MaxHistoryDays = 540;

    public static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "ASN Bank",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = Version,

        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,

            // residential, unlike ING's "any": a device-authenticated bank's fraud rules watch where the session comes from
            // (datacentre egress is unproven here)
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },

        UnattendedFetch = false,

        // the human needs their device, not this browser: the challenge relay reaches them anywhere
        LoginNeedsHeadedAgent = false,

        // Session: runs when a fetch fails on our side, since an abandoned session stays open at ASN, whose fraud rules watch for it
        // LogoutAsync confirms it by the page reached (/uitgelogd.html), not by having clicked
        Logout = LogoutSupport.Session,
        SecretCustody = SecretCustody.Client,

        // Ephemeral as ING: the stricter value makes the provider unreachable from a browser
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "asn",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // QR scan: ASN no longer issues digipas readers, and the old ChallengeResponse form demanded a serial nobody has
            Flow = AuthFlow.QrScan,

            Steps = [new AuthStep { Id = "scan", LabelKey = "connect.asn.step.scan", Fields = [] }],

            // live view, not a still QR: the code rotates every few seconds; the scan ends by the bank moving the browser on
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec
            {
                // an hour, UNVERIFIED: the second discovery session was cut short by ASN's idle timeout, so the window is not generous
                TtlSeconds = 3600,
                Refreshable = false,
                RotatesOnUse = false,
            },

            // a reauth means the phone again: not cheap, and the platform must not retry into it on a schedule
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            BankResources.AccountsSpec(),

            // no maxRecordsPerFetch: a CAMT.053 statement is one document, and truncating it would break its balance chain
            // one account type (current): the export cannot tell current from savings; four types let callers tick ones the bank lacks
            // the accounts parameter decides what a caller is SHOWN, not what leaves the bank: one export covers every account
            BankResources.TransactionsSpec(
                maxHistoryDays: MaxHistoryDays,
                typicalDurationSeconds: 60,
                accountTypes: ["current"],
                notesKey: WholeExportKey),
        ],
        // settlement lag 0: CAMT.053 entries are booked and the parser refuses unbalanced statements, so no late-booking gap exists
        Limits = BankLimits.ForBank(maxHistoryDays: MaxHistoryDays, settlementLagDays: 0),
    };
}
