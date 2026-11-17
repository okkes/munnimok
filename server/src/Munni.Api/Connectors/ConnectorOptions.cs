namespace Munni.Api.Connectors;

// absent BaseUrl: no connectors here and the relay is not mapped; present: every other setting is required,
// a half-configured control plane must never look healthy
public sealed class ConnectorOptions
{
    public const string SectionName = "Connectors";

    /// <summary>The control plane's root on the environment's network, e.g. <c>http://connector-dev:8392/</c>.</summary>
    public string? BaseUrl { get; set; }

    // development only: the shared secret in X-Connector-Key; production leaves it empty and uses the M2M application
    public string? DevKey { get; set; }

    public string? M2mAppId { get; set; }

    public string? M2mAppSecret { get; set; }

    public string? Audience { get; set; }

    // Logto grants a client-credentials token only the scopes the request names: without it /v1/admin/* answers 403
    public string? Scope { get; set; } = "connector:admin";

    // rotating it severs every connection of this environment and exposes nothing else
    public string? SubjectSalt { get; set; }

    // absent: no household agents here; enrollment answers without an address
    public string? AgentPublicUrl { get; set; }

    // per-user budget on login, on top of the connector's per-provider interval
    public int LoginsPerHour { get; set; } = 20;

    // 60, not 12: the app syncs every connection on open and after sign-in; twelve ran out within the hour on a healthy bank
    // the connector's own interval guards the parties, this one guards the relay
    public int SyncsPerHour { get; set; } = 60;

    // off: no stand-in party is offered and the relay refuses to sign one in; the lab bench reaches them either way (#526)
    public bool OfferFixtures { get; set; }

    // above the control plane's own 25 s window, after which a fetch answers 202
    public int TimeoutSeconds { get; set; } = 60;

    public bool Configured => !string.IsNullOrWhiteSpace(BaseUrl);

    public bool UsesDevKey => !string.IsNullOrWhiteSpace(DevKey);

    // the machine pair is written back by the platform's Logto module after the first bootstrap:
    // its absence is a stage, not a fault
    public bool HasCredential =>
        UsesDevKey
        || (!string.IsNullOrWhiteSpace(M2mAppId) && !string.IsNullOrWhiteSpace(M2mAppSecret) && !string.IsNullOrWhiteSpace(Audience));

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
