namespace Munni.Api.Connectors;

/// <summary>
/// <c>Connectors:*</c> — the one connector control plane of this environment
/// (docs/connector-integration-plan.md §5). Absent <see cref="BaseUrl"/>
/// means this environment runs no connectors: the relay is not mapped and
/// <c>/health</c> says so. Present, every other setting it needs is required
/// and a missing one refuses to start — a control plane that is reachable
/// but half-configured must never look healthy.
/// </summary>
public sealed class ConnectorOptions
{
    public const string SectionName = "Connectors";

    /// <summary>The control plane's root on the environment's network, e.g. <c>http://connector-dev:8392/</c>.</summary>
    public string? BaseUrl { get; set; }

    /// <summary>
    /// Development only: the shared secret the control plane accepts in
    /// <c>X-Connector-Key</c>. Production leaves it empty and mints machine
    /// tokens with the M2M application instead.
    /// </summary>
    public string? DevKey { get; set; }

    /// <summary>Logto machine-to-machine application minting tokens for the connector's audience.</summary>
    public string? M2mAppId { get; set; }

    public string? M2mAppSecret { get; set; }

    /// <summary>The API resource indicator the control plane validates as its audience.</summary>
    public string? Audience { get; set; }

    /// <summary>
    /// Per-environment secret the user id is HMAC-ed with to mint the subject
    /// the connector sees (§6). Rotating it severs every connection of this
    /// environment and exposes nothing else.
    /// </summary>
    public string? SubjectSalt { get; set; }

    /// <summary>
    /// Where a household agent dials in from the outside — the control
    /// plane's agent routes as published by the platform (M2), e.g.
    /// <c>https://api.munni.example/connector/</c>. Absent, this environment
    /// offers no household agents: enrollment answers without an address
    /// and the app says so.
    /// </summary>
    public string? AgentPublicUrl { get; set; }

    /// <summary>Per-user budget on <c>login</c>, on top of the connector's per-provider interval.</summary>
    public int LoginsPerHour { get; set; } = 10;

    /// <summary>Per-user budget on <c>sync</c>.</summary>
    public int SyncsPerHour { get; set; } = 12;

    /// <summary>
    /// One call's ceiling. A fetch waits up to the control plane's own window
    /// (25 s) before it answers 202, so this sits well above it.
    /// </summary>
    public int TimeoutSeconds { get; set; } = 60;

    public bool Configured => !string.IsNullOrWhiteSpace(BaseUrl);

    /// <summary>Development transport: the shared key instead of a machine token.</summary>
    public bool UsesDevKey => !string.IsNullOrWhiteSpace(DevKey);

    /// <summary>
    /// Whether the relay holds a credential the control plane accepts: the
    /// development key, or the machine application with its audience. The
    /// machine pair is written back by the platform's Logto module after the
    /// environment's first bootstrap, so its absence is a stage, not a fault
    /// — <see cref="ConnectorSetup"/> keeps the relay off and says why.
    /// </summary>
    public bool HasCredential =>
        UsesDevKey
        || (!string.IsNullOrWhiteSpace(M2mAppId) && !string.IsNullOrWhiteSpace(M2mAppSecret) && !string.IsNullOrWhiteSpace(Audience));

    /// <summary>Throws with the setting's name when a configured relay cannot work with what it was given.</summary>
    public void Require()
    {
        if (!Configured) return;
        if (!Uri.TryCreate(BaseUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException("Connectors:BaseUrl must be an absolute URL");
        if (string.IsNullOrWhiteSpace(SubjectSalt))
            throw new InvalidOperationException("Connectors:SubjectSalt is required when Connectors:BaseUrl is set");
        if (UsesDevKey || string.IsNullOrWhiteSpace(M2mAppId) && string.IsNullOrWhiteSpace(M2mAppSecret)) return;
        // half a machine pair, or a pair without the audience it is minted for, is a misconfiguration and not a stage
        if (string.IsNullOrWhiteSpace(M2mAppId) || string.IsNullOrWhiteSpace(M2mAppSecret) || string.IsNullOrWhiteSpace(Audience))
        {
            throw new InvalidOperationException(
                "Connectors:M2mAppId, Connectors:M2mAppSecret and Connectors:Audience belong together");
        }
    }

    /// <summary>The base address with a trailing separator, so relative paths resolve under it instead of replacing its last segment.</summary>
    public Uri BaseAddress()
    {
        var url = new Uri(BaseUrl!, UriKind.Absolute);
        return url.AbsoluteUri.EndsWith(Path.AltDirectorySeparatorChar)
            ? url
            : new Uri(url.AbsoluteUri + Path.AltDirectorySeparatorChar);
    }
}
