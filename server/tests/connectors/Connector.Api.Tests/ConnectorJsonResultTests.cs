using System.Reflection;
using System.Text;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Api.Tests;

/// carries ONE thing Results.Json could not, the response type into endpoint metadata; the wire must stay the same bytes
/// on the same status
public sealed class ConnectorJsonResultTests
{
    [Theory]
    [InlineData(StatusCodes.Status200OK)]
    [InlineData(StatusCodes.Status202Accepted)]
    public async Task The_funnel_writes_the_wire_encoding_on_the_status_it_was_given(int status)
    {
        var value = new AckResponse { Purged = 7 };

        var written = await ExecuteAsync(ConnectorResults.Json(value, status));

        // the same options Results.Json used, so the bytes are unchanged
        Assert.Equal(ConnectorJson.Serialize(value), written.Body);
        Assert.Equal("{\"purged\":7}", written.Body);
        Assert.Equal(status, written.Status);
        Assert.StartsWith("application/json", written.ContentType, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_default_overload_is_a_200()
    {
        var written = await ExecuteAsync(ConnectorResults.Json(new AckResponse { Purged = 0 }));

        Assert.Equal(StatusCodes.Status200OK, written.Status);
        Assert.Equal("{\"purged\":0}", written.Body);
    }

    [Fact]
    public void The_result_still_says_what_it_is_carrying()
    {
        var value = new AckResponse { Purged = 3 };
        var result = ConnectorResults.Json(value);

        Assert.Same(value, result.Value);
        Assert.Equal(StatusCodes.Status200OK, result.StatusCode);
    }

    /// the claim is static, so only ever a 200 (hence ConnectorResults.Json does not return this type);
    /// a wider claim would reach every route
    [Fact]
    public void The_metadata_claim_is_exactly_one_json_200_for_the_carried_type()
    {
        var metadata = MetadataOf<ConnectorJsonResult<AckResponse>>();

        var produces = Assert.IsType<ProducesResponseTypeMetadata>(Assert.Single(metadata));

        Assert.Equal(StatusCodes.Status200OK, produces.StatusCode);
        Assert.Equal(typeof(AckResponse), produces.Type);
        Assert.Equal("application/json", Assert.Single(produces.ContentTypes));
    }

    [Fact]
    public void The_claim_follows_the_carried_type_rather_than_being_fixed()
    {
        var metadata = MetadataOf<ConnectorJsonResult<CatalogResponse>>();

        Assert.Equal(
            typeof(CatalogResponse),
            Assert.IsType<ProducesResponseTypeMetadata>(Assert.Single(metadata)).Type);
    }

    private static IReadOnlyList<object?> MetadataOf<TResult>()
        where TResult : IEndpointMetadataProvider
    {
        var builder = new RouteEndpointBuilder(
            _ => Task.CompletedTask, RoutePatternFactory.Parse("/probe"), order: 0);

        // the handler MethodInfo is ignored (the type describes itself), so any method stands in
        TResult.PopulateMetadata(Probe, builder);

        return [.. builder.Metadata];
    }

    private static readonly MethodInfo Probe =
        typeof(ConnectorJsonResultTests).GetMethod(
            nameof(The_default_overload_is_a_200), BindingFlags.Public | BindingFlags.Instance)!;

    private static async Task<(int Status, string Body, string? ContentType)> ExecuteAsync(IResult result)
    {
        var services = new ServiceCollection();
        services.AddLogging();

        await using var provider = services.BuildServiceProvider();

        using var body = new MemoryStream();
        var context = new DefaultHttpContext { RequestServices = provider };
        context.Response.Body = body;

        await result.ExecuteAsync(context);

        return (context.Response.StatusCode, Encoding.UTF8.GetString(body.ToArray()), context.Response.ContentType);
    }
}
