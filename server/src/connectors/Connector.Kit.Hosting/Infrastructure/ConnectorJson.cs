using System.Text.Json;
using System.Text.Json.Serialization;

namespace Connector.Kit.Hosting.Infrastructure;

/// Snake case everywhere, enum members included (<c>browser_once</c>, <c>awaiting_input</c>). The enum converter is in
/// Converters because a converter in the collection beats the kit's type-level attributes.
public static class ConnectorJson
{
    public static JsonSerializerOptions Options { get; } = Build();

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);

    /// A malformed or absent JSON column falls back instead of failing the request: a corrupt staged row is an operator problem.
    public static T DeserializeOr<T>(string? json, T fallback)
    {
        if (string.IsNullOrWhiteSpace(json)) return fallback;

        try
        {
            return JsonSerializer.Deserialize<T>(json, Options) ?? fallback;
        }
        catch (JsonException)
        {
            return fallback;
        }
    }

    private static JsonSerializerOptions Build()
    {
        // the canonical encoding lives in the frozen contract: the agent must speak the same one, and a second set here
        // drifted apart and broke every agent-served fetch (ConnectorWireJson)
        var options = ConnectorWireJson.Clone();
        options.MakeReadOnly(populateMissingResolver: true);
        return options;
    }
}
