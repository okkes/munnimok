using System.Security.Claims;

namespace Munni.Api.Auth;

/// <summary>
/// Operator access: a caller is an admin iff the validated token carries
/// the `admin` scope in its space-separated `scope` claim — the shape
/// Logto issues for an API resource (the scope is defined on the API
/// resource and reaches a user through a role). No config list and no
/// database grants: the identity provider is the single source of truth,
/// and the one rule gates /admin, /control and the catalog publish.
/// </summary>
public static class AdminScope
{
    public const string Scope = "admin";

    /// <summary>authorization policy every operator route requires (Program.cs registers it)</summary>
    public const string Policy = "admin-scope";

    public static bool HasAdminScope(HttpContext http) => HasAdminScope(http.User);

    /// <summary>a JSON-array `scope` arrives as several claims, a string as one — both are read</summary>
    public static bool HasAdminScope(ClaimsPrincipal user) =>
        user.FindAll("scope")
            .SelectMany(claim => claim.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .Contains(Scope, StringComparer.Ordinal);
}
