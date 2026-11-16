using Connector.Kit.Adapters;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests;

// raw is the provider's own document beside each record, the more sensitive; README policy: raw payloads off in production
// withheld from the CATALOGUE so consumers do not offer a control production refuses;
// ParamBinder's enum check then refuses it by name
public sealed class RawPayloadOfferTests
{
    private static ProviderManifest Manifest(params string[] includeValues) => Make.Manifest() with
    {
        Resources =
        [
            new ResourceSpec
            {
                Id = "receipts",
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec
                    {
                        Key = ResourceRequest.IncludeParam,
                        Type = ParamType.Enum,
                        Values = includeValues,
                        Multi = true,
                    },
                ],
            },
        ],
    };

    private static IReadOnlyList<string> IncludeValues(ProviderRegistry registry) =>
        registry.RequireManifest("mock-provider").Resource("receipts")!
            .Param(ResourceRequest.IncludeParam)!.Values!;

    [Fact]
    public void A_development_catalogue_offers_raw_where_the_adapter_declared_it()
    {
        var registry = new ProviderRegistry(
            [new StubAdapter(Manifest("items", "raw"))], offerRawPayloads: true);

        Assert.Equal(["items", "raw"], IncludeValues(registry));
    }

    [Fact]
    public void A_production_catalogue_offers_everything_except_raw()
    {
        var registry = new ProviderRegistry(
            [new StubAdapter(Manifest("items", "raw"))], offerRawPayloads: false);

        // only `raw` goes: dropping `items` would take ordinary line items with it
        Assert.Equal(["items"], IncludeValues(registry));
    }

    // permissive default: a hand-built registry (test, agent) is not a production control plane; production says so explicitly
    [Fact]
    public void Raw_is_offered_unless_the_caller_says_otherwise()
    {
        var registry = new ProviderRegistry([new StubAdapter(Manifest("items", "raw"))]);

        Assert.Contains(ResourceRequest.RawInclude, IncludeValues(registry));
    }

    [Fact]
    public void A_provider_that_never_offered_raw_is_untouched_either_way()
    {
        var offered = new ProviderRegistry([new StubAdapter(Manifest("items"))], offerRawPayloads: true);
        var withheld = new ProviderRegistry([new StubAdapter(Manifest("items"))], offerRawPayloads: false);

        Assert.Equal(["items"], IncludeValues(offered));
        Assert.Equal(["items"], IncludeValues(withheld));

        // same catalogue, so a consumer's ETag does not move for a provider that lost nothing
        Assert.Equal(offered.CatalogDigest, withheld.CatalogDigest);
    }

    // a provider that offered raw must move its digest, or a cached catalogue keeps showing a control the service refuses
    [Fact]
    public void Withholding_raw_changes_the_catalogue_a_consumer_caches()
    {
        var offered = new ProviderRegistry([new StubAdapter(Manifest("items", "raw"))], offerRawPayloads: true);
        var withheld = new ProviderRegistry([new StubAdapter(Manifest("items", "raw"))], offerRawPayloads: false);

        Assert.NotEqual(offered.CatalogDigest, withheld.CatalogDigest);
    }

    private sealed class StubAdapter(ProviderManifest manifest) : IProviderAdapter
    {
        public ProviderManifest Describe() => manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
