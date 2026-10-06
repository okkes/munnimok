using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

/// <summary>
/// The lab's probe (#441): behind the same `admin` scope as /admin and
/// /control, mapped whether or not this environment runs connectors — the
/// lab asks it first (200 = admin, 403 = signed in without the scope) and
/// reads an environment without connectors from the 404 of the relayed
/// routes, never from a refusal here. Everything else of the lab lives in
/// <see cref="Connectors.ConnectorLabEndpoints"/>.
/// </summary>
public static class LabEndpoints
{
    public static void MapLab(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/lab").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        group.MapGet("/ping", () => Results.Ok(new { admin = true }));
    }
}
