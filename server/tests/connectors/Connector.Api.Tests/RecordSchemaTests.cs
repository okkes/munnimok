using Connector.Kit.Adapters;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Microsoft.OpenApi;
using ShopConnector.Adapters.Mock;

namespace Connector.Api.Tests;

// ApiDocumentTests can only show wrong shapes are excluded (a shop returns only receipts); the registry connector's
// shapes, which no API suite covers, are checked here
public sealed class RecordSchemaTests
{
    [Fact]
    public void A_service_publishes_the_shapes_its_providers_actually_return()
    {
        var shapes = RecordSchemaTransformer.Shapes(Registry(ResourceShape.CreditRegistration));

        Assert.Equal([ResourceShape.CreditRegistration], shapes);
    }

    // order follows the platform's own list, not provider registration, so the document does not churn on a rename
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

        Assert.Equal(
            [
                ResourceShape.Account, ResourceShape.Transaction, ResourceShape.Receipt,
                ResourceShape.CreditRegistration, ResourceShape.StudentDebt,
            ],
            RecordShapes.All.Keys);
    }

    [Fact]
    public void Every_resource_shape_has_a_record_behind_it()
    {
        foreach (var shape in Enum.GetValues<ResourceShape>())
        {
            Assert.True(RecordShapes.All.ContainsKey(shape), $"resource shape '{shape}' has no record");
            Assert.NotNull(RecordShapes.Require(shape));
        }
    }

    [Fact]
    public void One_shape_is_stated_flatly_and_several_are_a_choice()
    {
        var receipt = new OpenApiSchemaReference("Receipt");
        var credit = new OpenApiSchemaReference("CreditRegistration");

        // a oneOf of one puts the model behind a chooser in a reference browser
        Assert.Same(receipt, RecordSchemaTransformer.Rows([receipt]));

        var several = Assert.IsType<OpenApiSchema>(RecordSchemaTransformer.Rows([receipt, credit]));
        Assert.Equal([receipt, credit], several.OneOf);
    }

    // this generator writes a nullable reference as a oneOf beside a null: a check reading only the type flag calls it non-null
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

        // a plain array is what DataResponse carries and must stay required
        Assert.False(RecordSchemaTransformer.Nullable(new OpenApiSchema { Type = JsonSchemaType.Array }));
        Assert.False(RecordSchemaTransformer.Nullable(new OpenApiSchemaReference("JsonArray")));
    }

    // built on the real ProviderRegistry so the manifests pass ManifestValidator
    private static ProviderRegistry Registry(params ResourceShape[] shapes) =>
        new ProviderRegistry(shapes.Select((shape, index) => (IProviderAdapter)new ShapedAdapter(shape, index)));

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
