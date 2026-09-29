using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Manifests;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// Validates a login payload against the manifest that described the form.
///
/// The consumer already validated client-side from the same
/// <see cref="FieldSpec"/>, and that is exactly why this exists: a
/// client-side check is a courtesy to the user, not a guarantee to us. A
/// field arriving that the manifest never declared means the caller is
/// working from a different contract, and passing it through to an adapter
/// would make the manifest advisory.
/// </summary>
public static class AuthInputValidator
{
    /// <summary>A pattern is a validator, not a puzzle; a runaway one must not become a stall.</summary>
    private static readonly TimeSpan PatternBudget = TimeSpan.FromMilliseconds(100);

    public static void ValidateInputs(ProviderManifest manifest, IReadOnlyDictionary<string, string> inputs)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(inputs);

        // THE MANIFEST DECIDES, on this flow as on every other.
        //
        // This read "device_persistent has no credential step at all" and
        // refused every input outright, which made every persistent provider
        // that declares a field impossible to connect. ASN declares the five
        // digits a browser the bank already trusts signs in with; the mock
        // bank declares an agent id and its login requires one. Send what
        // those manifests ask for and the answer was "this provider's login
        // takes no inputs"; send nothing and a required field is missing
        // instead. There was no third thing to try, and every test of those
        // two called the adapter directly, so nothing said so.
        //
        // The third persistent provider - the shop's mock - declares no
        // fields and was unaffected, which is how a rule contradicting two
        // manifests stayed quiet: the one provider that agreed with it was
        // the only one anybody ever connected.
        //
        // The rule it was reaching for is already here, one line down and
        // applied uniformly: only what the manifest declared. A
        // device_persistent provider that really takes nothing declares no
        // fields, and "unknown input" refuses the lot - without a second rule
        // that a manifest can contradict and nothing reconciles.
        var declared = manifest.Auth.Steps.SelectMany(s => s.Fields).ToList();
        Validate(declared, inputs, "input");
    }

    public static void ValidateConfig(ProviderManifest manifest, IReadOnlyDictionary<string, string> config)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(config);
        Validate(manifest.Auth.Config, config, "config");
    }

    private static void Validate(IReadOnlyList<FieldSpec> declared, IReadOnlyDictionary<string, string> supplied, string what)
    {
        var byKey = declared.ToDictionary(f => f.Key, StringComparer.Ordinal);

        if (supplied.Keys.FirstOrDefault(key => !byKey.ContainsKey(key)) is { } unknown)
        {
            throw ConnectorException.InvalidRequest($"unknown {what} '{unknown}'");
        }

        foreach (var field in declared)
        {
            if (!supplied.TryGetValue(field.Key, out var value) || string.IsNullOrEmpty(value))
            {
                if (field.Required) throw ConnectorException.InvalidRequest($"{what} '{field.Key}' is required");
                continue;
            }

            if (field.Type == FieldType.Select && field.Options is { } options &&
                !options.Contains(value, StringComparer.Ordinal))
            {
                // The value itself is echoed only for a select, where the
                // options are public and the value cannot be a secret.
                throw ConnectorException.InvalidRequest($"{what} '{field.Key}' does not accept '{value}'");
            }

            if (field.Pattern is { } pattern && !Matches(pattern, value))
            {
                // Never the value: this field may be a password, and an error
                // message is the most-logged string in any system.
                throw ConnectorException.InvalidRequest($"{what} '{field.Key}' does not match its declared pattern");
            }
        }
    }

    private static bool Matches(string pattern, string value)
    {
        try
        {
            return Regex.IsMatch(value, pattern, RegexOptions.None, PatternBudget);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            // The validator rejects a bad pattern at startup, so reaching here
            // means the manifest changed underneath us. Refusing the input is
            // the safe reading.
            return false;
        }
    }
}
