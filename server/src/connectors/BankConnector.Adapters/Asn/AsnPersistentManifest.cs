using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Asn;

/// <summary>
/// ASN on the account holder's own machine, signed in and staying that way.
///
/// <para>
/// This is the reason ASN is on the roadmap at all. Its "edge login" keeps a
/// browser session alive indefinitely, so a persistent Playwright profile on
/// hardware the user owns can be pointed at it once and fetch for ever after.
/// It is the only route to unattended bank sync anywhere in this project, and
/// the entire justification for the BYO agent protocol.
/// </para>
///
/// <para>
/// <b>Declared here and deliberately not implemented.</b> The catalogue entry
/// is decidable - custody, tier, what a bundle holds, what happens when the
/// machine is off - because all of that is platform. The login is not: it is
/// the same unobserved screens as the pooled variant, plus a profile that
/// stays signed in afterwards. Building THAT against guessed selectors would
/// combine the two worst properties available - a permanently authenticated
/// bank session, and no evidence that any of it does what it says.
/// </para>
///
/// <para>
/// The honest caveat this owes a user, and the reason it should never be
/// offered casually: an always-signed-in browser profile on their own machine
/// is a real, continuous bank session. It is safer than handing a password to a
/// service and more dangerous than signing in each time, and a consumer that
/// offers it without saying so is making the choice on their behalf.
/// </para>
/// </summary>
internal static class AsnPersistentManifest
{
    public const int Version = 1;

    public const string ProviderId = "asn-persistent";

    /// <summary>
    /// "This keeps a browser signed in to your bank, on your own computer."
    /// </summary>
    /// <remarks>
    /// The one manifest here whose notes key is load-bearing rather than
    /// informative. Every other provider's explains a limitation; this one
    /// explains a risk the user is accepting, and a consumer that renders it
    /// quietly has mis-rendered it.
    /// </remarks>
    public const string NotesKey = "connect.asn.notes.persistent_session";

    /// <summary>
    /// "Register this browser with ASN. Choose the same five digits you gave
    /// us." Shown while the registration page is streamed.
    /// </summary>
    public const string RegisterKey = "connect.asn.register_browser";

    public static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "ASN Bank (always-on)",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserPersistent,
        Agent = new AgentRequirement
        {
            Required = true,

            // BYO, which is the whole point: the profile lives on the user's
            // machine, so the session never exists anywhere this platform runs.
            Class = AgentClass.Byo,
        },

        // TRUE, and the only manifest in this repository that says so about a
        // bank. Everything else needs a person with a phone or a device.
        UnattendedFetch = true,

        // AGENT: the bundle holds { agent_id, profile_id } and no secret at
        // all. There is nothing here to steal, which is what makes a fully
        // persistent connection acceptable on the web as well.
        SecretCustody = SecretCustody.Agent,

        // Ephemeral is the strongest value this enum has, and it undersells
        // what happens here. The BUNDLE dies with the tab, as it says - but the
        // bundle is a pointer rather than a credential, so a web user who
        // reconnects lands back on a profile that never signed out. The
        // connection is persistent; only the handle to it is not.
        WebSupport = WebSupport.Ephemeral,

        // Signing out would destroy the persistent session, which is the asset.
        // A user who wants it gone revokes the agent or deletes the profile.
        Logout = LogoutSupport.None,
        LogoRef = "asn",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.DevicePersistent,
            Steps =
            [
                new AuthStep
                {
                    Id = "agent",
                    LabelKey = "connect.asn.step.agent",
                    Fields =
                    [
                        // WHICH MACHINE IS NOT AN INPUT. It was declared here
                        // as a required `agent_id` field, and nothing on any
                        // side ever read it: routing comes off `prefer_agent`
                        // on the request, which is where `ResolveProfileAsync`
                        // looks and what the login request documents as
                        // required for exactly this flow. So a consumer had to
                        // fill a field in to get past validation and then
                        // supply the same id a second time for it to mean
                        // anything.
                        //
                        // A field that states a fact nothing reads is worse
                        // than no field: it reads as the mechanism, and the
                        // real mechanism goes unnoticed beside it.

                        // THE FIVE DIGITS A TRUSTED BROWSER SIGNS IN WITH.
                        //
                        // OPTIONAL, because a browser has to be registered
                        // before it has one - and registration is a long human
                        // errand (an e-mail code, an SMS code, a debit card)
                        // that this connector sends somebody to rather than
                        // drives. Without it the first connect is the ordinary
                        // QR sign-in; with it, and once the profile is
                        // registered, every sign-in after that is five digits
                        // and no phone at all.
                        //
                        // OPTIONAL TO THE VALIDATOR, NOT TO A REGISTERED
                        // BROWSER. Its sign-in page has no method buttons, so
                        // there is no QR to fall back to: the adapter refuses
                        // with invalid_request, naming this key, rather than
                        // hunt a page for a route it has never offered. Only
                        // the page can say which it is, which is why the
                        // manifest cannot.
                        //
                        // SECRET, and held by the client. It arrives as an
                        // input, is typed, and is never sealed into the bundle
                        // - which is what keeps the two factors apart: the
                        // profile is the thing you have, this is the thing you
                        // know, and each is worthless without the other.
                        new FieldSpec
                        {
                            Key = AsnPersistentAdapter.BrowserCodeKey,
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = "connect.asn.field.browser_code",
                            Pattern = "^[0-9]{5}$",
                        },
                    ],
                },
            ],

            // ONCE, at enrolment, and never again - which is the difference
            // between this manifest and the pooled one.
            //
            // LIVE VIEW, and this said QrDisplay and CodeDisplay until the
            // adapter was written against it. Those were reasonable when this
            // file was a sketch and are simply wrong about the bank: ASN's code
            // rotates every few seconds, so a still photograph relayed once has
            // expired by the time somebody has their phone out. The pooled
            // manifest learned that from a live session and this one had no way
            // to hear about it - a manifest declaring a challenge type its own
            // login cannot use.
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec
            {
                // A year. Not a claim about ASN's edge login, which nobody has
                // measured - it is a bound on the POINTER, and a profile that
                // has actually been signed out fails its next fetch honestly.
                TtlSeconds = 31_536_000,
                Refreshable = true,
                RotatesOnUse = false,
            },

            // Cheap: re-authenticating means the agent re-opening its own
            // profile, with no human involved unless the profile is really
            // gone.
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            BankResources.AccountsSpec(),
            BankResources.TransactionsSpec(maxHistoryDays: 540, typicalDurationSeconds: 60),
        ],
        Limits = BankLimits.ForBank(maxHistoryDays: 540),
    };
}
