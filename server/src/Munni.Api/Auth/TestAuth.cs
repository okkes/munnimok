using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Munni.Api.Data;

namespace Munni.Api.Auth;

/// <summary>
/// Header-based auth for CI/e2e (Auth:TestMode=true): the caller supplies
/// X-User-Sub and is treated as that subject. Never enabled in production;
/// Logto JWT bearer takes its place there.
/// </summary>
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "TestAuth";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var sub = Request.Headers["X-User-Sub"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(sub))
            return Task.FromResult(AuthenticateResult.Fail("missing X-User-Sub"));

        var identity = new ClaimsIdentity([new Claim("sub", sub)], SchemeName);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

public static class UserResolution
{
    private const string ItemKey = "munni.userId";

    /// <summary>JIT-provisions a user row for the authenticated subject.</summary>
    public static async Task ResolveUser(HttpContext http, AppDbContext db, Func<Task> next)
    {
        // "sub" with MapInboundClaims=false; NameIdentifier as a safety net
        var sub = http.User.FindFirstValue("sub") ?? http.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!string.IsNullOrEmpty(sub))
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
            if (user is null)
            {
                user = new User { Id = Guid.NewGuid(), Sub = sub };
                db.Users.Add(user);
                try
                {
                    await db.SaveChangesAsync();
                }
                catch (DbUpdateException)
                {
                    // a fresh app launch fires several requests at once and
                    // they all JIT-provision the same sub — the unique index
                    // (IX_Users_Sub) lets exactly one insert win; the losers
                    // adopt that row instead of answering 500
                    db.Entry(user).State = EntityState.Detached;
                    user = await db.Users.FirstAsync(u => u.Sub == sub);
                }
            }
            http.Items[ItemKey] = user.Id;
        }
        await next();
    }

    public static Guid GetUserId(this HttpContext http) =>
        http.Items[ItemKey] as Guid? ?? throw new InvalidOperationException("no resolved user");

    /// <summary>null on anonymous requests (endpoints that allow them)</summary>
    public static Guid? TryGetUserId(this HttpContext http) => http.Items[ItemKey] as Guid?;
}
