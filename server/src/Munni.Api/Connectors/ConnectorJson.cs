using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Munni.Api.Connectors;

// the connector speaks snake_case, this API camelCase; keys that hold DATA (config, inputs, fetch params, raw payload)
// keep their keys verbatim, renaming corrupts them
public static class ConnectorJson
{
    private static readonly HashSet<string> DataKeys = new(StringComparer.Ordinal)
    {
        "config", "inputs", "params", "raw",
    };

    /// <summary>The fields a bundle rides in — stripped from anything that is not the direct answer to the caller holding it.</summary>
    private static readonly string[] SecretKeys = ["bundle", "credential_bundle", "credentialBundle", "session"];

    public static JsonNode? ToCamel(JsonNode? node) => Walk(node, rename: true, CamelCase);

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

    public static string? Text(this JsonObject obj, string property) =>
        obj[property] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    public static string Serialize(object value) => JsonSerializer.Serialize(value, Web);

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
}
