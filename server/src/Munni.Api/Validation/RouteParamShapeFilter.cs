using System.Text.RegularExpressions;

namespace Munni.Api.Validation;

/// rejects string route params that do not look like this API's identifiers;
/// Guid-constrained params already pass, this catches the free-form ones
public sealed partial class RouteParamShapeFilter : IEndpointFilter
{
    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex SafeShape();

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        foreach (var value in context.HttpContext.Request.RouteValues.Values)
        {
            if (value is string s && !SafeShape().IsMatch(s))
                return Results.BadRequest(new { error = "malformed route parameter" });
        }
        return await next(context);
    }
}

public static class RouteParamShapeExtensions
{
    public static RouteGroupBuilder WithSafeRouteParams(this RouteGroupBuilder group) =>
        group.AddEndpointFilter(new RouteParamShapeFilter());
}
