using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

// mapped whether or not this environment runs connectors (#441): the lab reads one without connectors
// from the 404 of the relayed routes, never from a refusal here
public static class LabEndpoints
{
    public static void MapLab(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/lab").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        group.MapGet("/ping", () => Results.Ok(new { admin = true }));
    }
}
