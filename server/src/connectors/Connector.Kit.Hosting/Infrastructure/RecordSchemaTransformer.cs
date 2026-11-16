using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Connector.Kit.Hosting.Infrastructure;

// registers the records as components and points data at them: the handler returns a JsonArray, so data was "anything"
// a oneOf, not a discriminated union: a record has no type field, and the manifest's returns already names the shape
internal sealed class RecordSchemaTransformer(IProviderRegistry registry) : IOpenApiDocumentTransformer
{
    private static readonly (string Schema, string Property)[] Carriers =
    [
        ("DataResponse", "data"),
        ("JobResponse", "data"),
    ];

    // only the shapes the registered manifests return: the reference belongs to one service
    // and must not describe an API it does not serve
    internal static IReadOnlyList<ResourceShape> Shapes(IProviderRegistry providers)
    {
        ArgumentNullException.ThrowIfNull(providers);

        var returned = providers.Manifests
            .SelectMany(manifest => manifest.Resources)
            .Select(resource => resource.Returns)
            .ToHashSet();

        return [.. RecordShapes.All.Keys.Where(returned.Contains)];
    }

    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(context);

        var rows = new List<IOpenApiSchema>();
        var legend = new List<string>();

        foreach (var shape in Shapes(registry))
        {
            var record = RecordShapes.Require(shape);

            // through the generator, not hand-built: a hand-written schema would be a second, stale definition of the wire format
            var schema = await context.GetOrCreateSchemaAsync(record, cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            document.AddComponent(record.Name, schema);

            rows.Add(new OpenApiSchemaReference(record.Name, document));
            legend.Add($"`{Wire(shape)}` → `{record.Name}`");
        }

        // no providers registered: an empty oneOf would claim the array holds nothing, so leave the generic array alone
        if (rows.Count == 0) return;

        var description =
            "One normalised record per element. Which shape a row has is decided by the RESOURCE, "
            + "not by this response, and a caller knows it before calling: the manifest states it "
            + "per resource as `returns`, so `GET /v1/providers/{id}` answers \"what will I get "
            + "back\" without fetching anything. In this service, " + string.Join(", ", legend) + ".";

        foreach (var (name, property) in Carriers) Point(document, name, property, description, rows);
    }

    // silent when the schema is absent: a connector that never mapped the job routes has no JobResponse to annotate
    private static void Point(
        OpenApiDocument document,
        string schemaName,
        string propertyName,
        string description,
        IReadOnlyList<IOpenApiSchema> rows)
    {
        if (document.Components?.Schemas is not { } schemas) return;
        if (!schemas.TryGetValue(schemaName, out var envelope)) return;
        if (envelope is not OpenApiSchema { Properties: { } properties }) return;
        if (!properties.TryGetValue(propertyName, out var replaced)) return;

        // nullability carried over from the replaced schema (JobResponse is nullable: an unfinished job has no rows)
        var type = JsonSchemaType.Array;
        if (Nullable(replaced)) type |= JsonSchemaType.Null;

        properties[propertyName] = new OpenApiSchema
        {
            Type = type,
            Description = description,
            Items = Rows(rows),
        };
    }

    // a oneOf of one draws a chooser over a single option in a reference browser, so one shape is stated flatly
    internal static IOpenApiSchema Rows(IReadOnlyList<IOpenApiSchema> records)
    {
        ArgumentNullException.ThrowIfNull(records);
        return records.Count == 1 ? records[0] : new OpenApiSchema { OneOf = [.. records] };
    }

    // null is a type flag, or a oneOf beside a $ref - the form a nullable component reference takes
    internal static bool Nullable(IOpenApiSchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        return (schema.Type?.HasFlag(JsonSchemaType.Null) ?? false)
            || (schema.OneOf?.Any(option => option.Type?.HasFlag(JsonSchemaType.Null) ?? false) ?? false);
    }

    // through the wire policy: the legend is looked up against real manifests, where CreditRegistration never appears
    private static string Wire(ResourceShape shape) =>
        JsonSerializer.Serialize(shape, ConnectorWireJson.Options).Trim('"');
}
