using System.Text.Json.Serialization;
using Connector.Kit.Challenges;

namespace Connector.Kit.Manifests;

public sealed record AuthSpec
{
    public required AuthFlow Flow { get; init; }

    // non-secret settings needed on every call (Lidl's country and language): neither credentials nor challenges; without
    // this section the alternative is a provider-specific hack in the consuming app
    public IReadOnlyList<FieldSpec> Config { get; init; } = [];

    public required IReadOnlyList<AuthStep> Steps { get; init; }

    // what the provider may raise: Flow is the happy path, and a password flow can still hit a CAPTCHA
    public IReadOnlyList<ChallengeType> Challenges { get; init; } = [];

    public required SessionSpec Session { get; init; }

    public ReauthSpec Reauth { get; init; } = new();

    // the allowlist a live view photographs within: a federated login is not one site (DUO: mijn.duo.nl -> login.digid.nl),
    // and empty pins to the opening host, cutting the picture off when the human needs it; empty stays the default.
    // Wildcards are refused: a stream following a login anywhere is a live remote view of an authenticated account
    [JsonPropertyName("login_origins")]
    public IReadOnlyList<string> LoginOrigins { get; init; } = [];

    // hosts whose session cookies a kept profile must NOT carry into its next browser; empty keeps everything. DUO's SAML
    // request carries ForceAuthn=true, so a restored DigiD session saves nothing yet changed the page the sign-in met.
    // Adapter-stated (the kit cannot tell an identity provider from a portal); drops the host's and subdomains' cookies only
    [JsonPropertyName("drops_kept_session_for")]
    public IReadOnlyList<string> DropsKeptSessionFor { get; init; } = [];

    public IEnumerable<FieldSpec> AllFields() => Config.Concat(Steps.SelectMany(s => s.Fields));
}

[JsonConverter(typeof(JsonStringEnumConverter<AuthFlow>))]
public enum AuthFlow
{
    Password,

    PasswordSms,

    PasswordTotp,

    TwoStep,

    MobileApproval,

    ChallengeResponse,

    QrScan,

    OauthRedirect,

    DevicePersistent,

    // no form and no credential: a provider declaring this MUST declare no fields, and the validator refuses one that does,
    // so "the credential never enters the platform" is structural rather than a claim
    RemoteBrowser,
}

public sealed record AuthStep
{
    public required string Id { get; init; }

    public string? LabelKey { get; init; }

    public required IReadOnlyList<FieldSpec> Fields { get; init; }
}

// a key, not prose: the consumer owns the copy in every language
public sealed record FieldSpec
{
    public required string Key { get; init; }

    public required FieldType Type { get; init; }

    // never reaches a log, screenshot or artifact; enforced by the redactor, not by adapter discipline
    public bool Secret { get; init; }

    public bool Required { get; init; } = true;

    public string? LabelKey { get; init; }

    /// <summary>Anchored regex for client-side validation.</summary>
    public string? Pattern { get; init; }

    public IReadOnlyList<string>? Options { get; init; }

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

    // listed at connect time (an aggregator's institutions, a registry's municipalities): too many or too changeable for
    // Options; the consumer asks GET /v1/{provider}/options/{field}?q=… and the adapter answers via ILookupProvider
    Lookup,
}

public sealed record SessionSpec
{
    public required int TtlSeconds { get; init; }

    public required bool Refreshable { get; init; }

    /// <summary>
    /// When true, every response may carry a re-issued bundle and the client
    /// must persist the newest.
    /// </summary>
    public bool RotatesOnUse { get; init; } = true;
}

public sealed record ReauthSpec
{
    public bool Cheap { get; init; }

    public IReadOnlyList<string> TriggerCodes { get; init; } = [];
}
