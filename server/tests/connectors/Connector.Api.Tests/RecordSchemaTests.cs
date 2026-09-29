using Connector.Kit.Adapters;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Microsoft.OpenApi;
using ShopConnector.Adapters.Mock;

namespace Connector.Api.Tests;

/// <summary>
/// The three decisions behind what a service publishes as its record models,
/// tested where the generated document cannot reach them.
///
/// <see cref="ApiDocumentTests"/> proves the wiring against a real host, but a
/// shop connector only ever returns receipts - so the document it produces can
/// show that the wrong shapes are EXCLUDED and never that the right ones are
/// included. The registry connector, whose whole reference now rests on
/// <c>credit_registration</c> arriving here, has no API suite of its own.
/// </summary>
public sealed class RecordSchemaTests
{
    /// <summary>
    /// The registry connector's case: a service whose providers return a shape
    /// no shop ever will. This is the half a shop-shaped document cannot show.
    /// </summary>
    [Fact]
    public void A_service_publishes_the_shapes_its_providers_actually_return()
    {
        var shapes = RecordSchemaTransformer.Shapes(Registry(ResourceShape.CreditRegistration));

        Assert.Equal([ResourceShape.CreditRegistration], shapes);
    }

    /// <summary>
    /// Two providers returning the same shape publish it once, and the order is
    /// the platform's own rather than whichever provider happened to register
    /// first - so a document does not churn because a provider was renamed.
    /// </summary>
    [Fact]
    public void Shapes_are_deduplicated_and_ordered_by_the_platforms_own_list()
    {
        var registry = Registry(
            ResourceShape.CreditRegistration,
            ResourceShape.Receipt,
            ResourceShape.Receipt,
            ResourceShape.Account);

        Assert.Equal(
            [ResourceShape.Account, ResourceShape.Receipt, ResourceShape.CreditRegistration],
            RecordSchemaTransformer.Shapes(registry));

        // The declaration order in the enum, which is what RecordShapes walks.
        Assert.Equal(
            [
                ResourceShape.Account, ResourceShape.Transaction, ResourceShape.Receipt,
                ResourceShape.CreditRegistration, ResourceShape.StudentDebt,
            ],
            RecordShapes.All.Keys);
    }

    /// <summary>
    /// Every shape has a record. A member added to the enum without one would
    /// be a resource a manifest could declare, a consumer could see in the
    /// catalogue, and nothing anywhere could describe.
    /// </summary>
    [Fact]
    public void Every_resource_shape_has_a_record_behind_it()
    {
        foreach (var shape in Enum.GetValues<ResourceShape>())
        {
            Assert.True(RecordShapes.All.ContainsKey(shape), $"resource shape '{shape}' has no record");
            Assert.NotNull(RecordShapes.Require(shape));
        }
    }

    // ---- what a row is -----------------------------------------------------

    [Fact]
    public void One_shape_is_stated_flatly_and_several_are_a_choice()
    {
        var receipt = new OpenApiSchemaReference("Receipt");
        var credit = new OpenApiSchemaReference("CreditRegistration");

        // A oneOf of one puts the model behind a chooser in a reference
        // browser, for a service that never makes the choice.
        Assert.Same(receipt, RecordSchemaTransformer.Rows([receipt]));

        var several = Assert.IsType<OpenApiSchema>(RecordSchemaTransformer.Rows([receipt, credit]));
        Assert.Equal([receipt, credit], several.OneOf);
    }

    // ---- whether there are any ---------------------------------------------

    /// <summary>
    /// Nullability is carried over from the schema being replaced, and this
    /// generator writes it two ways. A nullable reference to a component comes
    /// out as a <c>oneOf</c> beside a null - which is the form BOTH of these
    /// properties are actually in, so a check that only read the type flag
    /// would silently report every one of them as non-null and promise rows on
    /// a job that has not run yet.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_nullable_row_array_is_recognised_however_the_generator_wrote_it(bool asOneOf)
    {
        IOpenApiSchema nullable = asOneOf
            ? new OpenApiSchema
            {
                OneOf =
                [
                    new OpenApiSchema { Type = JsonSchemaType.Null },
                    new OpenApiSchemaReference("JsonArray"),
                ],
            }
            : new OpenApiSchema { Type = JsonSchemaType.Array | JsonSchemaType.Null };

        Assert.True(RecordSchemaTransformer.Nullable(nullable));

        // And the shape either form is distinguished FROM: a plain array, which
        // is what DataResponse carries and what must stay required.
        Assert.False(RecordSchemaTransformer.Nullable(new OpenApiSchema { Type = JsonSchemaType.Array }));
        Assert.False(RecordSchemaTransformer.Nullable(new OpenApiSchemaReference("JsonArray")));
    }

    /// <summary>
    /// A registry of providers returning exactly the given shapes, built out of
    /// the real <see cref="ProviderRegistry"/> so the manifests go through
    /// <c>ManifestValidator</c> on the way in - a stub that skipped it could
    /// declare a resource no service could ever serve.
    /// </summary>
    private static ProviderRegistry Registry(params ResourceShape[] shapes) =>
        new ProviderRegistry(shapes.Select((shape, index) => (IProviderAdapter)new ShapedAdapter(shape, index)));

    /// <summary>
    /// The mock store, renamed and with its resource's shape swapped. Built
    /// from a shipped manifest rather than written from scratch so it stays a
    /// valid provider without this file having to know what makes one.
    /// </summary>
    private sealed class ShapedAdapter(ResourceShape shape, int index) : IProviderAdapter
    {
        public ProviderManifest Describe()
        {
            var manifest = MockStoreAdapters.Create(MockStoreAdapters.Simple).Describe();

            return manifest with
            {
                Id = $"shaped-{index}",
                Resources = [.. manifest.Resources.Select(resource => resource with { Returns = shape })],
            };
        }

        public Task<LoginResult> LoginAsync(IJobContext context, CancellationToken cancellationToken) =>
            throw new NotSupportedException("this provider exists to be described, never run");

        public Task<FetchResult> FetchAsync(IJobContext context, ResourceRequest request, CancellationToken cancellationToken) =>
            throw new NotSupportedException("this provider exists to be described, never run");
    }
}
