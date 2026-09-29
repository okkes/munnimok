using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

using RegistryConnector.Adapters.Support;

namespace RegistryConnector.Adapters.Duo;

internal static class DuoManifest
{
    /// <summary>
    /// TWO, because version 1 collected nothing and this one may.
    ///
    /// The bump is not bookkeeping. A bundle sealed under version 1 was sealed
    /// against a manifest that declared no fields at all, and every bundle is
    /// bound to <c>(provider, subject, manifest_version)</c> precisely so that
    /// a change to what a login collects cannot be applied to material minted
    /// before it. Anyone connected under 1 signs in again.
    /// </summary>
    public const int Version = 2;

    /// <summary>
    /// Fifteen minutes of INACTIVITY, which is what DUO's own responses state.
    /// </summary>
    /// <remarks>
    /// CONFIRMED on 2026-08-11 rather than inferred. Every response from DUO's
    /// services carries a <c>session-timeout</c> header, and it was watched
    /// counting down - 900, 868, 852 - and snapping back to 900 on the next
    /// request. So it is an idle timer that each call refreshes, not a clock
    /// that starts at sign-in.
    /// <para>
    /// The number stays 900 because that is the honest floor: a connection
    /// that is not being used really does expire that fast, and a manifest
    /// promising longer would have a consumer schedule a fetch against a
    /// session that is gone. What the idle behaviour buys is that a fetch which
    /// starts in time cannot time out halfway through - each of its calls pushes
    /// the window out again.
    /// </para>
    /// </remarks>
    public const int SessionTtlSeconds = 900;

    public static ProviderManifest Build() => new()
    {
        Id = DuoAdapter.ProviderId,
        Name = "DUO",
        Kind = ProviderKind.Registry,
        Country = "NL",
        ManifestVersion = Version,

        // T3. DigiD is a browser login and nothing else can stand in for it,
        // but nothing needs a browser to stay open once the cookies exist.
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            // Not negotiable and not the interesting field: DigiD is a browser
            // login, and a browser cannot run in the control plane's process.
            Required = true,

            // POOLED as of 2026-09-21, by the product owner, deliberately. It
            // said Byo from 2026-08-10 - the day this adapter was written -
            // and the reasoning it said it for is kept below rather than
            // deleted, because reversing this needs somebody to know exactly
            // what was decided and on what.
            //
            // WHY IT WAS BYO. Logius runs a registered misuse-detection
            // algorithm over IP, failed authentications and BSN. A pooled fleet
            // authenticating many distinct citizens from one egress is that
            // signature exactly, and the consequence lands on the account
            // holder rather than on us: DigiD is how somebody files their taxes
            // and renews their passport.
            //
            // WHAT THAT DECLARATION DID FOR SIX WEEKS: nothing. The lease
            // query matched on provider id and runtime alone, so every DUO run
            // there has ever been - the live sign-ins of 2026-08-11 included -
            // was served by the operator's POOLED fleet agent. It became a rule
            // on 2026-09-20 and was one for a day, which is how anybody found
            // out: the next connect was refused.
            //
            // THE CLEAN BROWSER IS A DIFFERENT AXIS, and it is the first thing
            // anybody reaches for, so: a pooled agent does hand every job a
            // fresh browser. It gets no profile directory (JobRunner.ResolveProfile
            // returns null off this class), opens its own context, and carries
            // no session between runs (BrowserLeaseOptions.KeepsSessionAcrossBrowsers
            // is IsOwnMachine). No citizen's DigiD session is ever handed to the
            // next caller. That is true and it is not what Logius scores - the
            // ADDRESS an authentication arrives from is not changed by wiping
            // the browser behind it.
            //
            // WHAT BRINGS THE QUESTION BACK: many citizens' DigiD
            // authentications arriving from ONE SHARED EGRESS in a real
            // deployment. That does not exist. Today the "fleet" is a container
            // on the account holder's own connection serving exactly one
            // person, on the same egress their own NAS would have, so the rule
            // cost them the way they test DUO and bought nothing. The day an
            // operator runs a fleet in a datacenter for more than one
            // household, this goes back to Byo - or, better, the enforcement is
            // gated on ConnectorOptions.IsProduction, which already tells a
            // deployment from a laptop, and the fleet keeps DUO here.
            Class = AgentClass.Pooled,

            // STAYS, and it is not the same statement as the class above. The
            // class says WHOSE machine; this says what DUO wants of whichever
            // machine takes the job, which is still a Dutch residential address
            // for the reason written out above. Nothing enforces it - the only
            // source is an agent's own claim - and that is deliberate and
            // recorded on AgentRequirement.
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },

        // FALSE, and CONFIRMED false rather than assumed: DUO's SAML request
        // carries ForceAuthn=true, so DigiD re-authenticates the human every
        // single time whatever session anybody holds.
        UnattendedFetch = false,

        // The person DigiD needs has a phone, not a keyboard at the agent.
        // Whichever method they choose is answered from where they are: an sms
        // arrives on the phone, and the app path relays a QR to it.
        LoginNeedsHeadedAgent = false,

        // TRUE as of version 2, and this is the one line in this manifest that
        // gives something up.
        //
        // Version 1 was flow 'remote_browser', which the validator will only
        // accept from a provider declaring NO fields - so "no DigiD credential
        // can enter this platform" was structural rather than promised. That
        // is gone, deliberately and at the account holder's request: retyping a
        // DigiD username and password for every sync, on a provider that
        // re-authenticates every sync by design, is friction that stops people
        // syncing at all.
        //
        // What survives is the custody model, which is the part that was doing
        // the real work: SecretCustody.Client means the credential is sealed
        // into a bundle the user's own device holds and this platform stores
        // nothing. And the second factor is untouched - DigiD still texts a
        // code to their phone on every single sign-in, which is what actually
        // stands between a stored password and somebody else's dossier.
        //
        // Both fields stay OPTIONAL. Storing nothing is still a supported way
        // to use this provider and still gets the streamed sign-in.
        OffersCredentialStore = true,

        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "duo",
        NotesKey = MessageKeys.DuoNotes,

        Auth = new AuthSpec
        {
            // Credentials, then a code texted to a phone. Which is what DigiD
            // by sms IS, and what version 1 declined to say because it
            // collected nothing at all.
            Flow = AuthFlow.PasswordSms,

            Config =
            [
                // Which DigiD method to DRIVE, and it only means anything on
                // the typed path: with nothing stored the human picks on
                // DigiD's own screen and a stored preference could only
                // contradict them.
                //
                // Defaults to sms because it is the method that finishes on
                // the machine already in front of somebody. The app path is
                // offered because it exists and some people have no other,
                // and it still ends in the QR relay.
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

                    // BOTH OPTIONAL, and that is the whole design - the same
                    // tiering BKR uses:
                    //
                    //   nothing            -> DigiD's own page is streamed
                    //                         from its first screen
                    //   username+password  -> both are typed, and the only
                    //                         thing asked of the human is the
                    //                         six digits DigiD just texted
                    //
                    // Required fields would make the first impossible to
                    // offer, and the first is what a cautious person's connect
                    // looks like - and what everybody's first connect looks
                    // like before they decide whether to trust this with a
                    // DigiD password at all.
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

            // LiveView carries the sign-in itself. QrDisplay is the upgrade on
            // the app path: DigiD draws its QR as a PNG inline in the markup,
            // so the exact bytes it generated can be relayed rather than
            // photographed - and a photographed QR is one the phone sometimes
            // cannot read.
            // MfaCode is what the typed path asks for and nothing else: six
            // digits, into a box, which is a far better experience than
            // streaming a whole browser to type them. LiveView still covers
            // everything the typed path cannot - a changed page, a consent
            // screen, a password reset - and QrDisplay the app method.
            Challenges = [ChallengeType.MfaCode, ChallengeType.LiveView, ChallengeType.QrDisplay],

            // The two hosts a DigiD sign-in genuinely spans, and the reason
            // this field exists at all.
            //
            // Without them the live view pins to whichever host the page was on
            // when the stream opened - mijn.duo.nl - and stops the instant the
            // main frame moves to DigiD. Which is the exact moment the human
            // needs to see the screen: it left them looking at a frozen "Bezig
            // met authenticeren..." with a login they could not finish.
            //
            // Exactly two, and no wildcard. *.duo.nl would keep the camera
            // running over an authenticated account long after the sign-in was
            // over, and the validator refuses it.
            LoginOrigins = ["mijn.duo.nl", "login.digid.nl"],

            // THE SAME HOST AS THE LINE ABOVE, FOR THE OPPOSITE REASON, and
            // that pair is the clearest way to state what this provider is: the
            // stream MUST follow the human to DigiD, and the profile must NOT
            // bring DigiD's session back.
            //
            // MEASURED ON THE OWNER'S ACCOUNT ON 2026-09-28, four connects in
            // three minutes. Twice on the operator's fleet, where the typed
            // sign-in completed and the notes were empty; twice on their own
            // machine, where the first fell back to the streamed hand-over with
            // "the typed sign-in did not complete (ProviderChanged)" and they
            // drove DigiD's "Hoe wilt u inloggen?" chooser by hand. The fleet
            // agent keeps no profile (JobRunner.ResolveProfile returns null off
            // AgentClass.Pooled), so its browser reached login.digid.nl holding
            // nothing. Theirs reached it holding DIGID_SAML_SESSION,
            // f5avraaaaaaaaaaaaaaaa_session_, f5_cspm, session-TrafficCount and
            // TS01ab71c3 - five cookies of DigiD's out of the kept session.
            //
            // AND NONE OF THEM COULD EVER HAVE SAVED AN AUTHENTICATION. That is
            // not a judgment call, it is UnattendedFetch above, confirmed rather
            // than assumed: DUO's SAML request carries ForceAuthn=true, so
            // DigiD re-authenticates the human every single time whatever
            // session anybody holds. A restored DigiD session buys nothing by
            // the provider's own design and changes the page the typed sign-in
            // meets - cost with no benefit, which is exactly what this field is
            // for.
            //
            // mijn.duo.nl IS NOT HERE AND MUST NOT BE. DUO's own four session
            // cookies - AMWEBJCT!%2Fisam!JSESSIONID, PD-S-SESSION-ID,
            // PD_STATEFUL_... - are what make "this profile was still inside
            // DUO, so nothing was asked of you" work, which the owner has now
            // seen twice and which is the entire reason a BYO agent is worth
            // running for this provider. Dropping those would delete the tier.
            DropsKeptSessionFor = ["login.digid.nl"],

            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,

                // Nothing to refresh, and nothing that would help: even a
                // renewable session would still meet ForceAuthn on the next
                // sign-in.
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

                // No since and no until. DUO states what is owed NOW; asking
                // it for "the debt since March" is a question it has no way to
                // answer, and declaring the parameter would invite one.
                //
                // `ledger` is declared because it costs something a caller
                // must choose to spend: the booked movements exist only inside
                // DUO's customer dossier, so asking for them means that
                // request is made. Everything else on this record comes from
                // narrow endpoints that carry no identity at all.
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

                // Exactly one. A person has one student debt, published as a
                // handful of component amounts - see StudentDebt for why that
                // is one record and not eight.
                MaxRecordsPerFetch = 1,

                // Three small JSON calls behind a browser that is already
                // signed in. The sign-in itself is where the minutes go, and
                // that is a human's time rather than this.
                TypicalDurationSeconds = 15,
            },
        ],

        // An hour, and it is not what protects DUO - ForceAuthn does that, by
        // making every sync cost a human a DigiD login. This just stops a
        // consumer's retry loop turning into a request loop.
        Limits = new ProviderLimits { MinIntervalSeconds = 3_600, Concurrency = 1 },
    };
}
