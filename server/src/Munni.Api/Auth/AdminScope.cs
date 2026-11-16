using System.Security.Claims;

namespace Munni.Api.Auth;

// admin iff the token's space-separated `scope` claim carries `admin`.
// the identity provider is the single source of truth (no config list, no database grants)
public static class AdminScope
{
    public const string Scope = "admin";

    public const string Policy = "admin-scope";

    public static bool HasAdminScope(HttpContext http) => HasAdminScope(http.User);

    /// <summary>a JSON-array `scope` arrives as several claims, a string as one — both are read</summary>
    public static bool HasAdminScope(ClaimsPrincipal user) =>
        user.FindAll("scope")
            .SelectMany(claim => claim.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .Contains(Scope, StringComparer.Ordinal);
}
