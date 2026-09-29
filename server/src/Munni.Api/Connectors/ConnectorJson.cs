using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Munni.Api.Connectors;

/// <summary>
/// The relay renders every connector document in munni's own casing: the
/// connector speaks snake_case, the rest of this API speaks camelCase, and
/// the app should not have to know where a field came from. Keys that hold
/// DATA rather than schema — a provider's config, the inputs a user typed,
/// fetch params, a raw payload — keep their keys verbatim, because renaming
/// data corrupts it.
/// </summary>
public static class ConnectorJson
{
    /// <summary>Object-valued fields whose keys are data, never renamed.</summary>
    private static readonly HashSet<string> DataKeys = new(StringComparer.Ordinal)
    {
        "config", "inputs", "params", "raw",
    };

    /// <summary>The fields a bundle rides in — stripped from anything that is not the direct answer to the caller holding it.</summary>
    private static readonly string[] SecretKeys = ["bundle", "credential_bundle", "credentialBundle", "session"];

    public static JsonNode? ToCamel(JsonNode? node) => Walk(node, rename: true, CamelCase);

    /// <summary>The other direction, for a body the app wrote that the relay hands on verbatim (the live view's input).</summary>
    public static JsonNode? ToSnake(JsonNode? node) => Walk(node, rename: true, SnakeCase);

    public static string SnakeCase(string key)
    {
        var builder = new StringBuilder(key.Length + 4);
        foreach (var ch in key)
        {
            if (char.IsUpper(ch))
            {
                if (builder.Length > 0) builder.Append('_');
                builder.Append(char.ToLowerInvariant(ch));
            }
            else
            {
                builder.Append(ch);
            }
        }
        return builder.ToString();
    }

    /// <summary>A copy without the bundle-carrying fields, for a stream or a log line.</summary>
    public static JsonObject WithoutSecrets(JsonObject view)
    {
        var copy = (JsonObject)view.DeepClone();
        foreach (var key in SecretKeys) copy.Remove(key);
        return copy;
    }

    public static string CamelCase(string key)
    {
        if (!key.Contains('_')) return key;
        var parts = key.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return key;
        var builder = new StringBuilder(parts[0]);
        for (var i = 1; i < parts.Length; i++)
        {
            builder.Append(char.ToUpperInvariant(parts[i][0]));
            builder.Append(parts[i], 1, parts[i].Length - 1);
        }
        return builder.ToString();
    }

    private static JsonNode? Walk(JsonNode? node, bool rename, Func<string, string> style)
    {
        switch (node)
        {
            case JsonObject obj:
            {
                var copy = new JsonObject();
                foreach (var (key, value) in obj)
                {
                    var childRenames = rename && !DataKeys.Contains(key);
                    copy[rename ? style(key) : key] = Walk(value, childRenames, style);
                }
                return copy;
            }
            case JsonArray array:
            {
                var copy = new JsonArray();
                foreach (var item in array) copy.Add(Walk(item, rename, style));
                return copy;
            }
            case null:
                return null;
            default:
                return JsonNode.Parse(node.ToJsonString());
        }
    }

    /// <summary>Reads a string property, or null when it is absent or not a string.</summary>
    public static string? Text(this JsonObject obj, string property) =>
        obj[property] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    /// <summary>Serialises an app-facing object with this API's default (camelCase) encoding.</summary>
    public static string Serialize(object value) => JsonSerializer.Serialize(value, Web);

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
}
