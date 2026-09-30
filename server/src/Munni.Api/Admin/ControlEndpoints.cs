using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

/// <summary>
/// Control area (admin split LS5/LS6): the shared-services cockpit behind
/// the same `admin` scope as /admin (AdminScope). The cockpit is read-only
/// by design: it probes this environment here and reads the connector
/// control plane through <c>/control/connectors/*</c> (the parties with
/// their quota, an aggregator's inventory of consents) — every write, the
/// kill switch and a consent's revocation included, stays in the
/// environment's own admin portal.
/// </summary>
public static class ControlEndpoints
{
    public static void MapControl(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/control").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        // the cockpit probes this first: 200 = admin, 403 = signed in without the scope
        group.MapGet("/ping", () => Results.Ok(new { admin = true }));
    }
}
