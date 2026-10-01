using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Connector.Kit.Hosting.Infrastructure;

/// <summary>
/// Puts the normalised records into the API document, so a consumer can read
/// the shape of a row before it fetches one.
///
/// Without this the reference stops exactly where it gets interesting. Every
/// route names the envelope it answers with - <c>DataResponse</c>, its cursor,
/// its <c>complete</c> flag - and then describes <c>data</c> as an array of
/// anything at all, because the handler really does hand back a
/// <see cref="System.Text.Json.Nodes.JsonArray"/>: rows are staged as JSON and
/// the envelope is one type for every resource of every provider. So the
/// generator was telling the truth about the C#, and the truth about the C#
/// was useless. "What comes back when I fetch receipts" had no answer in the
/// document, and the only way to find out was to connect a real account to a
/// real provider and look at what arrived.
///
/// The shape was never unknown. A manifest has always stated it per resource -
/// <c>returns: "receipt"</c> - so a caller knows WHICH shape before it calls;
/// what it could not do was look that name up anywhere. This registers the
/// four records as components and points <c>data</c> at them, which turns
/// <c>returns</c> into a resolvable reference and makes the pair of them a
/// complete answer.
/// </summary>
/// <remarks>
/// A <c>oneOf</c> rather than a discriminated union, because there is nothing
/// on the wire to discriminate ON: a record carries no type field, and adding
/// one to satisfy a schema would be putting a field in everybody's data to
/// describe something the manifest already says. The resource decides, one
/// resource only ever returns one shape, and the description says so.
/// </remarks>
internal sealed class RecordSchemaTransformer(IProviderRegistry registry) : IOpenApiDocumentTransformer
{
    /// <summary>The envelopes carrying rows, and the property that holds them.</summary>
    private static readonly (string Schema, string Property)[] Carriers =
    [
        ("DataResponse", "data"),
        ("JobResponse", "data"),
    ];

    /// <summary>
    /// The shapes THIS service can return, in the platform's declaration
    /// order.
    ///
    /// Read off the registered manifests rather than taken as the whole enum,
    /// because the reference belongs to one service. A shop connector cannot
    /// return a credit registration under any provider, resource or parameter,
    /// and offering one in its document would be describing an API it does not
    /// serve - which is the exact fault this whole change exists to fix, just
    /// pointing the other way. The registry connector's document says
    /// <c>CreditRegistration</c> and nothing else, so its fetch route has one
    /// answer rather than a menu.
    /// </summary>
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

            // Through the generator rather than hand-built, so a record's
            // fields are described exactly as the service serialises them -
            // snake_case names, enums as their wire strings, nested types
            // registered as their own components. A schema written by hand
            // here would be a second definition of the wire format, and the
            // one that goes stale.
            var schema = await context.GetOrCreateSchemaAsync(record, cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            document.AddComponent(record.Name, schema);

            rows.Add(new OpenApiSchemaReference(record.Name, document));
            legend.Add($"`{Wire(shape)}` → `{record.Name}`");
        }

        // A service with no providers registered has nothing to promise, and
        // an empty oneOf would say "this array may contain nothing that
        // exists". Leave the generic array alone.
        if (rows.Count == 0) return;

        var description =
            "One normalised record per element. Which shape a row has is decided by the RESOURCE, "
            + "not by this response, and a caller knows it before calling: the manifest states it "
            + "per resource as `returns`, so `GET /v1/providers/{id}` answers \"what will I get "
            + "back\" without fetching anything. In this service, " + string.Join(", ", legend) + ".";

        foreach (var (name, property) in Carriers) Point(document, name, property, description, rows);
    }

    /// <summary>
    /// Repoints one envelope's row array at the records.
    ///
    /// Silent when the schema is not there. This runs over whatever document
    /// the host actually produced, and a connector that never mapped the job
    /// routes has no <c>JobResponse</c> to annotate - which is a smaller
    /// service, not a broken one.
    /// </summary>
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

        // Nullable on JobResponse and not on DataResponse, and that difference
        // is real: a job that has not finished has no rows yet. Carried over
        // from the schema being replaced rather than restated, so describing
        // the rows cannot quietly change what the envelope promises about
        // whether there are any.
        var type = JsonSchemaType.Array;
        if (Nullable(replaced)) type |= JsonSchemaType.Null;

        properties[propertyName] = new OpenApiSchema
        {
            Type = type,
            Description = description,
            Items = Rows(rows),
        };
    }

    /// <summary>
    /// What one element of the array is.
    /// </summary>
    /// <remarks>
    /// A <c>oneOf</c> of one is noise, and worse than noise in a reference
    /// browser: it draws a chooser over a single option and puts the model
    /// behind a click. A service with one shape - which the registry connector
    /// is, and the shop connector is - says so flatly instead.
    /// </remarks>
    internal static IOpenApiSchema Rows(IReadOnlyList<IOpenApiSchema> records)
    {
        ArgumentNullException.ThrowIfNull(records);
        return records.Count == 1 ? records[0] : new OpenApiSchema { OneOf = [.. records] };
    }

    /// <summary>
    /// Whether a schema admits null, in either of the two ways this generator
    /// writes it: as a flag on a plain type, and as a <c>oneOf</c> beside a
    /// <c>$ref</c> - which is the form a nullable reference to a component
    /// takes, and therefore the form these properties are actually in.
    /// </summary>
    internal static bool Nullable(IOpenApiSchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        return (schema.Type?.HasFlag(JsonSchemaType.Null) ?? false)
            || (schema.OneOf?.Any(option => option.Type?.HasFlag(JsonSchemaType.Null) ?? false) ?? false);
    }

    /// <summary>
    /// The shape's name as it appears in a manifest. Through the wire policy,
    /// because the point of the legend is to be looked up against a real
    /// manifest and <c>CreditRegistration</c> never appears in one.
    /// </summary>
    private static string Wire(ResourceShape shape) =>
        JsonSerializer.Serialize(shape, ConnectorWireJson.Options).Trim('"');
}
