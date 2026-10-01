using System.Text.RegularExpressions;

namespace Connector.Kit.Manifests;

/// <summary>
/// Manifests are the public contract, so they are validated at startup and
/// a bad one refuses to boot. A manifest that lies - claiming unattended
/// operation it cannot deliver, or a TTL longer than the session really
/// lasts - makes the consuming app promise things to users and then fail,
/// which is worse than not supporting the provider at all.
/// </summary>
public static partial class ManifestValidator
{
    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex IdPattern { get; }

    [GeneratedRegex("^[A-Z]{2}$")]
    private static partial Regex CountryPattern { get; }

    public static void Validate(ProviderManifest m)
    {
        ArgumentNullException.ThrowIfNull(m);
        var errors = new List<string>();

        if (!IdPattern.IsMatch(m.Id)) errors.Add($"id '{m.Id}' must be lowercase kebab-case");
        if (!CountryPattern.IsMatch(m.Country)) errors.Add($"country '{m.Country}' must be ISO-3166 alpha-2 uppercase");
        if (m.ManifestVersion < 1) errors.Add("manifest_version must be >= 1");
        if (m.Resources.Count == 0) errors.Add("at least one resource is required");

        ValidateCustody(m, errors);
        ValidateAgent(m, errors);
        ValidateAuth(m, errors);
        ValidateResources(m, errors);

        if (errors.Count > 0)
        {
            throw new InvalidOperationException(
                $"provider manifest '{m.Id}' is invalid:{Environment.NewLine}- " +
                string.Join(Environment.NewLine + "- ", errors));
        }
    }

    private static void ValidateCustody(ProviderManifest m, List<string> errors)
    {
        // Storing a secret that cannot be used without a human present buys
        // risk and no feature, so the combination is refused outright.
        if (m.SecretCustody == SecretCustody.Server && !m.UnattendedFetch)
        {
            errors.Add("secret_custody 'server' requires unattended_fetch: true - " +
                       "storing a secret that needs a human to use is pure risk");
        }

        // Agent custody means the control plane holds nothing at all, which
        // only makes sense when a specific machine holds the session.
        if (m.SecretCustody == SecretCustody.Agent && m.Runtime != ProviderRuntime.BrowserPersistent)
        {
            errors.Add("secret_custody 'agent' requires runtime 'browser_persistent'");
        }

        if (m.SecretCustody == SecretCustody.Agent && m.Agent.Class != AgentClass.Byo)
        {
            errors.Add("secret_custody 'agent' requires agent.class 'byo'");
        }

        ValidateCredentialStore(m, errors);
    }

    /// <summary>
    /// A stored password is the heaviest thing this platform will hold on a
    /// user's behalf, so the three cases where it buys nothing are refused
    /// outright rather than left to a reviewer to notice.
    /// </summary>
    private static void ValidateCredentialStore(ProviderManifest m, List<string> errors)
    {
        if (!m.OffersCredentialStore) return;

        if (m.SecretCustody != SecretCustody.Client)
        {
            errors.Add("offers_credential_store needs secret_custody 'client'; " +
                       $"'{m.SecretCustody}' means the credential does not live on the user's device");
        }

        // Nothing is typed, so there is nothing to seal. A manifest offering a
        // store here would advertise a bundle that always arrives empty.
        if (!m.Auth.AllFields().Any())
        {
            errors.Add("offers_credential_store needs an auth step with fields; " +
                       $"flow '{m.Auth.Flow}' collects nothing to store");
        }

        // The refresh already removes the reason to keep a password. Storing
        // one anyway is pure risk for a re-ask that was not going to happen.
        if (m.Auth.Session.Refreshable)
        {
            errors.Add("offers_credential_store is refused on a refreshable session - " +
                       "the refresh is what stops the human being asked again");
        }
    }

    private static void ValidateAgent(ProviderManifest m, List<string> errors)
    {
        // A browser cannot run in the control plane: it has no browser
        // binaries, and running one there would put provider traffic on the
        // wrong egress entirely.
        if (m.Runtime != ProviderRuntime.Http && !m.Agent.Required)
        {
            errors.Add($"runtime '{m.Runtime}' needs an agent; only 'http' may run inline");
        }

        if (m.Agent is { Required: false, Class: not AgentClass.Inline })
        {
            errors.Add("agent.required false implies agent.class 'inline'");
        }

        if (m.Runtime == ProviderRuntime.BrowserPersistent && m.Agent.Class != AgentClass.Byo)
        {
            errors.Add("runtime 'browser_persistent' is BYO-only: a persistent login " +
                       "belongs on hardware the user controls");
        }

        // "A human must be at the browser" is meaningless where there is no
        // browser. Refused at boot rather than left to read as a mysterious
        // routing constraint on a provider that only ever speaks HTTP.
        if (m.LoginNeedsHeadedAgent && m.Runtime == ProviderRuntime.Http)
        {
            errors.Add("login_needs_headed_agent has no meaning on runtime 'http': " +
                       "there is no browser for anyone to sit at");
        }
    }

    private static void ValidateAuth(ProviderManifest m, List<string> errors)
    {
        var auth = m.Auth;

        if (auth.Session.TtlSeconds <= 0) errors.Add("auth.session.ttl_seconds must be positive");

        ValidateFlow(m, auth, errors);

        if (m.UnattendedFetch && !auth.Session.Refreshable && auth.Flow != AuthFlow.DevicePersistent)
        {
            errors.Add("unattended_fetch: true requires a refreshable session - " +
                       "without one a human is needed every time by definition");
        }

        ValidateFields(auth, errors);

        // A password that is not marked secret would be logged and
        // screenshotted, because redaction keys off exactly this flag.
        foreach (var field in auth.AllFields().Where(f => f.Type == FieldType.Password && !f.Secret))
        {
            errors.Add($"field '{field.Key}' is a password but is not marked secret");
        }

        ValidateHosts("auth.login_origins", auth.LoginOrigins, errors);

        // THE SAME SHAPE, FOR THE OPPOSITE REASON. A host named here is one
        // whose session a kept profile must not carry forward, and a scheme or
        // a path on it would match no cookie ever set - so the origin nobody
        // meant to keep would go on being kept, with no error to read. The
        // wildcard refusal is worth less here than on the list above (a
        // wildcard would drop MORE, which is the safe direction) and is kept
        // anyway, because a manifest field that accepts two spellings of the
        // same intent is a field two adapters will disagree about.
        ValidateHosts("auth.drops_kept_session_for", auth.DropsKeptSessionFor, errors);
    }

    /// <summary>
    /// A list of bare hosts, as both of the manifest's host lists must be.
    ///
    /// On <c>auth.login_origins</c> every rule here refuses something that
    /// would widen the live view's allowlist beyond a host somebody named on
    /// purpose. That latch is what stops a stream from becoming a remote view of
    /// an account after the login it was opened for has finished, so a manifest
    /// that could smuggle a wildcard past it would make the guarantee
    /// decorative.
    /// </summary>
    /// <remarks>
    /// SHARED RATHER THAN COPIED, and the caller names itself in the message.
    /// A second copy of these four rules is a second place for them to drift,
    /// and the failure they exist to prevent is identical on both lists: a host
    /// that cannot compare equal to anything matches nothing and says nothing.
    /// </remarks>
    private static void ValidateHosts(string field, IReadOnlyList<string> hosts, List<string> errors)
    {
        foreach (var origin in hosts)
        {
            if (string.IsNullOrWhiteSpace(origin))
            {
                errors.Add($"{field} contains a blank host");
                continue;
            }

            if (origin.Contains('*', StringComparison.Ordinal))
            {
                errors.Add($"{field} '{origin}' is a wildcard; a stream that follows a login " +
                           "wherever it goes is a live remote view of an authenticated account");
            }

            // A bare host, because that is what the latch compares against. A
            // scheme or a path here would never match anything, so the stream
            // would pin to the opening host and stop at the identity provider -
            // the exact failure the list was added to fix, arriving silently.
            if (origin.Contains("://", StringComparison.Ordinal) || origin.Contains('/', StringComparison.Ordinal))
            {
                errors.Add($"{field} '{origin}' must be a bare host, with no scheme and no path");
            }

            if (!origin.Equals(origin.Trim(), StringComparison.Ordinal)
                || !origin.Equals(origin.ToLowerInvariant(), StringComparison.Ordinal))
            {
                errors.Add($"{field} '{origin}' must be lowercase and untrimmed of nothing");
            }
        }
    }

    /// <summary>What each flow demands of the runtime and the steps.</summary>
    private static void ValidateFlow(ProviderManifest m, AuthSpec auth, List<string> errors)
    {
        switch (auth.Flow)
        {
            // device_persistent has no credential step - the human authenticated
            // once, directly into a profile on their own machine.
            case AuthFlow.DevicePersistent when m.Runtime != ProviderRuntime.BrowserPersistent:
                errors.Add("flow 'device_persistent' requires runtime 'browser_persistent'");
                break;

            case AuthFlow.RemoteBrowser:
                // The inverse rule, and the reason this flow is worth having as a
                // flow rather than a convention: a streamed login must be INCAPABLE
                // of asking for a credential. A field here would mean a form
                // somewhere, and a form means a password crossing the wire and
                // resting in a job's inputs - the whole thing this exists to stop.
                // Refusing it at boot makes that structural instead of a promise.
                if (auth.AllFields().Any())
                {
                    errors.Add("flow 'remote_browser' must declare no fields: the human types into the " +
                               "provider's own page, so a field here would be a credential this platform " +
                               "collects and then claims not to hold");
                }

                if (m.Runtime == ProviderRuntime.Http)
                {
                    errors.Add("flow 'remote_browser' needs a browser to stream, so runtime 'http' cannot serve it");
                }

                break;

            case AuthFlow.DevicePersistent:
                break;

            default:
                if (auth.Steps.Count == 0) errors.Add($"flow '{auth.Flow}' requires at least one auth step");
                break;
        }
    }

    /// <summary>Every declared field: unique, a select with options, a pattern that compiles.</summary>
    private static void ValidateFields(AuthSpec auth, List<string> errors)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in auth.AllFields())
        {
            if (!keys.Add(field.Key)) errors.Add($"duplicate field key '{field.Key}'");

            if (field.Type == FieldType.Select && (field.Options is null || field.Options.Count == 0))
            {
                errors.Add($"field '{field.Key}' is a select but has no options");
            }

            if (field.Pattern is not null && !IsValidRegex(field.Pattern))
            {
                errors.Add($"field '{field.Key}' has an invalid pattern");
            }
        }
    }

    private static void ValidateResources(ProviderManifest m, List<string> errors)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var resource in m.Resources)
        {
            if (!IdPattern.IsMatch(resource.Id)) errors.Add($"resource id '{resource.Id}' must be kebab-case");
            if (!ids.Add(resource.Id)) errors.Add($"duplicate resource id '{resource.Id}'");
            if (resource.MaxRecordsPerFetch <= 0) errors.Add($"resource '{resource.Id}' max records must be positive");

            foreach (var p in resource.Params)
            {
                ValidateParam(resource, p, errors);
            }
        }
    }

    private static void ValidateParam(ResourceSpec resource, ParamSpec p, List<string> errors)
    {
        if (p.Type == ParamType.Enum && (p.Values is null || p.Values.Count == 0))
        {
            errors.Add($"param '{resource.Id}.{p.Key}' is an enum but lists no values");
        }

        if (p is { Required: true, Internal: true })
        {
            errors.Add($"param '{resource.Id}.{p.Key}' cannot be both required and internal");
        }
    }

    private static bool IsValidRegex(string pattern)
    {
        try
        {
            _ = Regex.Match(string.Empty, pattern, RegexOptions.None, TimeSpan.FromMilliseconds(100));
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
