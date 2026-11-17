using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

// the cockpit is read-only by design: every write, the kill switch and a consent's revocation included,
// stays in the environment's own admin portal
public static class ControlEndpoints
{
    public static void MapControl(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/control").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        // the cockpit probes this first: 200 = admin, 403 = signed in without the scope
        group.MapGet("/ping", () => Results.Ok(new { admin = true }));
    }
}
