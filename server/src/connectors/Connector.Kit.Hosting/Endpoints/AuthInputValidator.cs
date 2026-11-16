using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Manifests;

namespace Connector.Kit.Hosting.Endpoints;

/// client-side validation is a courtesy, not a guarantee: a field the manifest never declared means a different contract
/// and passing it to an adapter would make the manifest advisory
public static class AuthInputValidator
{
    /// <summary>A pattern is a validator, not a puzzle; a runaway one must not become a stall.</summary>
    private static readonly TimeSpan PatternBudget = TimeSpan.FromMilliseconds(100);

    public static void ValidateInputs(ProviderManifest manifest, IReadOnlyDictionary<string, string> inputs)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(inputs);

        // the manifest decides on this flow too: a blanket "device_persistent takes no inputs" rule contradicted ASN's and
        // the mock bank's declared fields; a persistent provider that takes nothing declares no fields
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
