using System.Text.Json.Serialization;
using Connector.Kit.Challenges;

namespace Connector.Kit.Manifests;

/// <summary>
/// The login interface, in enough detail that a consumer can render a
/// complete, validated, localised form without knowing anything about the
/// provider.
/// </summary>
public sealed record AuthSpec
{
    public required AuthFlow Flow { get; init; }

    /// <summary>
    /// Non-secret settings the provider needs on every call - Lidl's country
    /// and language, for instance, which appear in its URLs and headers.
    /// Neither credentials nor challenges, so they get their own section;
    /// without it the alternative is a provider-specific hack in the
    /// consuming app, which is what the manifest exists to prevent.
    /// </summary>
    public IReadOnlyList<FieldSpec> Config { get; init; } = [];

    public required IReadOnlyList<AuthStep> Steps { get; init; }

    /// <summary>
    /// What this provider <em>may</em> raise. <see cref="Flow"/> describes
    /// the happy path; a password flow can still hit a CAPTCHA.
    /// </summary>
    public IReadOnlyList<ChallengeType> Challenges { get; init; } = [];

    public required SessionSpec Session { get; init; }

    public ReauthSpec Reauth { get; init; } = new();

    /// <summary>
    /// Every host a streamed login legitimately visits, exactly - no wildcards,
    /// no schemes, no paths.
    /// </summary>
    /// <remarks>
    /// This is the allowlist a live view photographs within, and it exists
    /// because a federated login is not one site. DUO's is the case that forced
    /// it: the human starts on <c>mijn.duo.nl</c>, is sent to
    /// <c>login.digid.nl</c> to prove who they are, and comes back. With no
    /// list the stream pins to whatever host the page was on when it opened and
    /// stops the moment the main frame leaves - which is the strictest rule
    /// available without a manifest, and cuts the picture off at exactly the
    /// moment the human needs it.
    /// <para>
    /// EMPTY IS THE RIGHT DEFAULT and stays the behaviour for every provider
    /// that does not set it: pin to where the page already is. A provider only
    /// declares hosts when its login genuinely crosses one, and declaring them
    /// is a claim an operator can read and check.
    /// </para>
    /// <para>
    /// Wildcards are refused by the validator rather than merely discouraged. A
    /// stream that follows a login wherever it goes is a live remote view of an
    /// authenticated account, which is the one thing the latch exists to
    /// prevent - and <c>*.duo.nl</c> would keep the camera running long after
    /// the sign-in finished.
    /// </para>
    /// </remarks>
    [JsonPropertyName("login_origins")]
    public IReadOnlyList<string> LoginOrigins { get; init; } = [];

    /// <summary>
    /// Hosts whose session cookies a kept browser profile must NOT carry into
    /// its next browser - same shape as <see cref="LoginOrigins"/>, bare hosts
    /// only.
    /// </summary>
    /// <remarks>
    /// A DROP LIST RATHER THAN A KEEP LIST, and empty means keep everything,
    /// which is what every provider did before this field existed.
    /// <para>
    /// DUO is what forced it, on the owner's own machine on 2026-09-28. They
    /// connected it four times in three minutes: twice on the operator's fleet,
    /// where the typed DigiD sign-in completed cleanly both times, and twice on
    /// their own machine, where it did not - it fell back to the streamed
    /// hand-over and they drove DigiD's "Hoe wilt u inloggen?" chooser by hand.
    /// The one difference between the two machines is what the browser arrived
    /// at <c>login.digid.nl</c> holding. A fleet agent keeps no profile at all,
    /// so its browser arrived with nothing; theirs arrived holding
    /// <c>DIGID_SAML_SESSION</c> and four more cookies of DigiD's out of the
    /// profile's kept session.
    /// </para>
    /// <para>
    /// WHICH COULD NEVER HAVE PAID FOR ITSELF. DUO's SAML request carries
    /// <c>ForceAuthn=true</c> - confirmed, and recorded on
    /// <c>DuoManifest.UnattendedFetch</c> - so DigiD re-authenticates the human
    /// every single time whatever session anybody holds. A restored identity
    /// provider session cannot save one authentication by the provider's own
    /// design, while it demonstrably changes the page the typed sign-in meets.
    /// That is the shape this field is for: an origin whose session is cost with
    /// no benefit.
    /// </para>
    /// <para>
    /// DATA AN ADAPTER STATES, because the kit cannot know it. Nothing in
    /// <c>Connector.Kit.Agent</c> can tell an identity provider from a portal -
    /// <c>login.digid.nl</c> is a hostname with no meaning down there - and a
    /// kit that carried a list of them would need a release to learn about the
    /// next one. The provider that knows why DigiD's session is worthless is
    /// the provider that read DigiD's SAML request.
    /// </para>
    /// <para>
    /// A host here does NOT drop a cookie on a domain it merely shares. Naming
    /// <c>login.digid.nl</c> drops cookies scoped to that host and to hosts
    /// under it, and leaves a <c>.digid.nl</c> cookie alone, because a provider
    /// whose own portal sat under the same registrable domain as its identity
    /// provider would otherwise lose its own session to this rule. DUO does not
    /// - <c>duo.nl</c> and <c>digid.nl</c> are unrelated - and a rule whose
    /// safety depended on that accident would be the wrong rule. All five DigiD
    /// cookies in the owner's profile were on <c>login.digid.nl</c> or
    /// <c>.login.digid.nl</c>, so the evidence needs nothing wider; if a
    /// parent-domain session cookie ever turns up, the manifest names the
    /// parent and no code changes.
    /// </para>
    /// </remarks>
    [JsonPropertyName("drops_kept_session_for")]
    public IReadOnlyList<string> DropsKeptSessionFor { get; init; } = [];

    /// <summary>Every field across every step, plus config. Ordered.</summary>
    public IEnumerable<FieldSpec> AllFields() => Config.Concat(Steps.SelectMany(s => s.Fields));
}

/// <summary>
/// The login shapes we have actually encountered. Each implies a different
/// consumer UI and nothing else.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<AuthFlow>))]
public enum AuthFlow
{
    /// <summary>One step: username + password.</summary>
    Password,

    /// <summary>Credentials, then a code delivered out of band to a phone.</summary>
    PasswordSms,

    /// <summary>Credentials, then a TOTP code.</summary>
    PasswordTotp,

    /// <summary>Username step, provider responds, then a secondary step.</summary>
    TwoStep,

    /// <summary>Credentials, then wait for approval in the provider's app.</summary>
    MobileApproval,

    /// <summary>Provider shows a number; a device or app turns it into a response code.</summary>
    ChallengeResponse,

    /// <summary>Provider shows a QR; the human scans it with the provider's app.</summary>
    QrScan,

    /// <summary>The human logs in on the provider's own site and hands back the redirect.</summary>
    OauthRedirect,

    /// <summary>Authenticated once into a BYO agent's persistent profile; no login endpoint after.</summary>
    DevicePersistent,

    /// <summary>
    /// The provider's own login page, streamed to the human, driven by them.
    ///
    /// There is no form for a consumer to draw and no credential for one to
    /// collect: the page is rendered in the agent's browser, photographed, and
    /// the human's pointer and keystrokes are replayed into it. They sign in
    /// exactly as they would on their own laptop.
    ///
    /// A provider declaring this MUST declare no fields at all, and the
    /// validator refuses one that does. That refusal is the point - it is what
    /// turns "the credential never enters the platform" from a claim in a
    /// design document into something a manifest cannot contradict. A field
    /// here would mean a form somewhere, and a form means a password crossing
    /// the wire and resting in a job's inputs, which is the entire thing this
    /// flow exists to stop.
    /// </summary>
    RemoteBrowser,
}

public sealed record AuthStep
{
    public required string Id { get; init; }

    public string? LabelKey { get; init; }

    public required IReadOnlyList<FieldSpec> Fields { get; init; }
}

/// <summary>
/// One input. <see cref="LabelKey"/> rather than prose because the consumer
/// owns the copy in every language it ships; a connector never emits
/// user-facing English.
/// </summary>
public sealed record FieldSpec
{
    public required string Key { get; init; }

    public required FieldType Type { get; init; }

    /// <summary>
    /// True when the value must never reach a log, a screenshot or an
    /// artifact. Enforced by the redactor, not by adapter discipline.
    /// </summary>
    public bool Secret { get; init; }

    public bool Required { get; init; } = true;

    public string? LabelKey { get; init; }

    /// <summary>Anchored regex for client-side validation.</summary>
    public string? Pattern { get; init; }

    /// <summary>Choices for <see cref="FieldType.Select"/>.</summary>
    public IReadOnlyList<string>? Options { get; init; }

    /// <summary>HTML autocomplete hint, e.g. <c>username</c>.</summary>
    public string? Autofill { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<FieldType>))]
public enum FieldType
{
    Text,
    Password,
    Number,
    Date,
    Select,
    Iban,
    Phone,

    /// <summary>
    /// A value the party lists at connect time — an aggregator's institutions,
    /// a registry's municipalities: too many, or too changeable, for
    /// <see cref="FieldSpec.Options"/>. The consumer asks
    /// <c>GET /v1/{provider}/options/{field}?q=…</c> (with the step's other
    /// values as context) and the adapter answers through
    /// <see cref="Adapters.ILookupProvider"/>.
    /// </summary>
    Lookup,
}

public sealed record SessionSpec
{
    /// <summary>How long a bundle stays valid before a full re-login.</summary>
    public required int TtlSeconds { get; init; }

    /// <summary>Whether the session can be renewed without a human.</summary>
    public required bool Refreshable { get; init; }

    /// <summary>
    /// When true, every response may carry a re-issued bundle and the client
    /// must persist the newest.
    /// </summary>
    public bool RotatesOnUse { get; init; } = true;
}

public sealed record ReauthSpec
{
    /// <summary>True when the session can be renewed silently, with no human.</summary>
    public bool Cheap { get; init; }

    public IReadOnlyList<string> TriggerCodes { get; init; } = [];
}
