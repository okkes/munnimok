using System.Text.Json;
using System.Text.Json.Serialization;

namespace Connector.Kit;

// the one JSON encoding of the platform, part of the frozen contract: control plane (snake_case) and agent (web defaults)
// once differed, and ResourceRequest, with no explicit names, broke every agent-served fetch job (queued until expiry)
public static class ConnectorWireJson
{
    public static JsonSerializerOptions Options { get; } = Build();

    // the naming policy must not change: it is what both ends agree on
    public static JsonSerializerOptions Clone()
    {
        var options = new JsonSerializerOptions(Options);
        return options;
    }

    private static JsonSerializerOptions Build()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,

            // Dictionary keys are DATA - provider config keys, adapter inputs,
            // provider ids. Renaming them would quietly corrupt a payload
            // rather than fail it.
            DictionaryKeyPolicy = null,

            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));
        return options;
    }
}
