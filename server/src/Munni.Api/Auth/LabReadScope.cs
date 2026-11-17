using System.Security.Claims;

namespace Munni.Api.Auth;

// the lab's reader (#635): a machine account reads the runs and their recordings; whoever holds `admin` reads them too
public static class LabReadScope
{
    public const string Scope = "lab:read";

    public const string Policy = "lab-read";

    public static bool MayRead(ClaimsPrincipal user) =>
        AdminScope.HasScope(user, AdminScope.Scope) || AdminScope.HasScope(user, Scope);
}

// a client-credentials token carries the application's own id as `sub` (Logto): it is nobody's account
public static class MachineCaller
{
    public static bool Is(ClaimsPrincipal user) =>
        user.FindFirst("client_id")?.Value is { Length: > 0 } client
        && string.Equals(client, user.FindFirst("sub")?.Value, StringComparison.Ordinal);
}

/// <summary>Marks the routes a machine may call; every other route refuses one.</summary>
public sealed class AdmitsMachines;
