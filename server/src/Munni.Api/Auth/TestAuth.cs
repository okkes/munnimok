using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Munni.Api.Data;

namespace Munni.Api.Auth;

// CI/e2e only (Auth:TestMode): X-User-Sub is the subject, X-User-Scope the `scope` claim ("admin" for operator routes);
// never enabled in production
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

        var claims = new List<Claim> { new("sub", sub) };
        var scope = Request.Headers["X-User-Scope"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(scope)) claims.Add(new Claim("scope", scope));

        var identity = new ClaimsIdentity(claims, SchemeName);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

public static class UserResolution
{
    private const string ItemKey = "munni.userId";

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
                    // a fresh launch fires parallel requests that all JIT-provision the same sub:
                    // the unique index (IX_Users_Sub) lets one insert win, the losers adopt that row
                    db.Entry(user).State = EntityState.Detached;
                    user = await db.Users.FirstAsync(u => u.Sub == sub);
                }
            }
            http.Items[ItemKey] = user.Id;
            if (!await TouchDeviceAsync(http, db, user.Id)) return; // refused (401) or revoked (410) — the request ends here
        }
        await next();
    }

    // every request must name its device (X-Munni-Device): an unnamed one could never be disconnected, so 401 device-required
    // a revoked device gets 410, not 403: the sync engine reads 403 as "membership lost" and would purge the space
    private static async Task<bool> TouchDeviceAsync(HttpContext http, AppDbContext db, Guid userId)
    {
        var deviceId = http.Request.Headers["X-Munni-Device"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(deviceId) || deviceId.Length > 64)
        {
            http.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await http.Response.WriteAsJsonAsync(new { error = "device-required" });
            return false;
        }

        var device = await db.UserDevices.FindAsync(userId, deviceId);
        if (device?.RevokedAt is not null)
        {
            http.Response.StatusCode = StatusCodes.Status410Gone;
            await http.Response.WriteAsJsonAsync(new { error = "device-revoked" });
            return false;
        }
        var now = DateTimeOffset.UtcNow;
        if (device is null)
        {
            var platform = http.Request.Headers["X-Munni-Platform"].FirstOrDefault();
            db.UserDevices.Add(new UserDevice
            {
                Id = deviceId,
                UserId = userId,
                Platform = platform is "android" or "ios" or "web" ? platform : null,
                CreatedAt = now,
                LastSeenAt = now,
            });
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateException) { db.ChangeTracker.Clear(); } // concurrent first requests — one wins
        }
        else if (now - device.LastSeenAt > TimeSpan.FromMinutes(15))
        {
            device.LastSeenAt = now; // throttled: one write per quarter hour
            await db.SaveChangesAsync();
        }
        return true;
    }

    public static Guid GetUserId(this HttpContext http) =>
        http.Items[ItemKey] as Guid? ?? throw new InvalidOperationException("no resolved user");

    public static Guid? TryGetUserId(this HttpContext http) => http.Items[ItemKey] as Guid?;
}
