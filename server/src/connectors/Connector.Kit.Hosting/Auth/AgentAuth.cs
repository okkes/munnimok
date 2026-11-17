using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Auth;

/// agents are a separate identity: a per-agent bearer token scoped to /agent/v1/*, revocable alone
/// so a user's own machine is never a way into the control plane; only the token's hash is stored, shown once
public sealed class AgentAuth(ConnectorDbContext db, IOptions<ConnectorOptions> options, TimeProvider time)
{
    private const string EnrollmentAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    private readonly ConnectorOptions _options = options.Value;

    public static string Hash(string token) =>
        "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public async Task<AgentRow?> ResolveAsync(HttpContext http, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(http);

        var header = http.Request.Headers.Authorization.ToString();
        if (string.IsNullOrWhiteSpace(header) ||
            !header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var hash = Hash(header["Bearer ".Length..].Trim());
        var agent = await db.Agents.FirstOrDefaultAsync(a => a.TokenHash == hash, ct);
        return agent is null || agent.Revoked ? null : agent;
    }

    /// short-lived, single-use, carries the subject so a BYO agent serves only who enrolled it; HMAC'd with a per-stack key
    public async Task<AgentEnrollmentCode> MintEnrollmentAsync(string subject, string name, CancellationToken ct)
    {
        var code = string.Create(14, 0, static (span, _) =>
        {
            "AGNT-".CopyTo(span);
            for (var i = 5; i < span.Length; i++)
            {
                span[i] = i == 9
                    ? '-'
                    : EnrollmentAlphabet[RandomNumberGenerator.GetInt32(EnrollmentAlphabet.Length)];
            }
        });

        var now = time.GetUtcNow();
        var row = new EnrollmentRow
        {
            CodeHash = Sign(code),
            Subject = subject,
            Name = name,
            ExpiresAt = now.AddSeconds(_options.Timeouts.EnrollmentCodeSeconds),
        };

        db.Enrollments.Add(row);
        await db.SaveChangesAsync(ct);

        return new AgentEnrollmentCode(code, row.ExpiresAt);
    }

    /// development only; resets the row rather than creating-if-absent: agent state and control-plane DB are separate
    /// volumes, so clearing one would leave the code spent for good; callers check the mode so the refusal is loud at start-up
    public Task SeedDevEnrollmentAsync(string code, CancellationToken ct) =>
        SeedStandingEnrollmentAsync(code, ConnectorOptions.DevFleetSubject, "development", ct);

    /// redeemable now and after every start; which caller may use it where is decided at start-up, not here
    public async Task SeedStandingEnrollmentAsync(string code, string subject, string name, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(code);
        ArgumentException.ThrowIfNullOrWhiteSpace(subject);

        var hash = Sign(code);
        var expiresAt = time.GetUtcNow().AddYears(10);
        var row = await db.Enrollments.FirstOrDefaultAsync(e => e.CodeHash == hash, ct);

        if (row is null)
        {
            db.Enrollments.Add(new EnrollmentRow
            {
                CodeHash = hash,
                Subject = subject,
                Name = name,
                ExpiresAt = expiresAt,
            });
        }
        else
        {
            row.Subject = subject;
            row.RedeemedAt = null;
            row.ExpiresAt = expiresAt;
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task<EnrollmentRow> RedeemEnrollmentAsync(string code, CancellationToken ct)
    {
        var hash = Sign(code);
        var row = await db.Enrollments.FirstOrDefaultAsync(e => e.CodeHash == hash, ct);

        if (row is null || row.RedeemedAt is not null || row.ExpiresAt <= time.GetUtcNow())
        {
            throw ConnectorException.InvalidRequest("enrollment code is unknown, used or expired");
        }

        row.RedeemedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return row;
    }

    public static string NewToken() =>
        "agtk_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private string Sign(string code)
    {
        var key = _options.EnrollmentHmacKey;
        if (string.IsNullOrEmpty(key))
        {
            // Development only; production start-up refuses a missing key.
            return Hash(code);
        }

        return "hmac:" + Convert.ToHexStringLower(
            HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(code)));
    }
}

public readonly record struct AgentEnrollmentCode(string Code, DateTimeOffset ExpiresAt);

/// the whole /agent/v1 group except enrollment, which the one-time code authenticates
public sealed class AgentAuthFilter : IEndpointFilter
{
    public const string ItemKey = "connector.agent";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        var auth = context.HttpContext.RequestServices.GetRequiredService<AgentAuth>();
        var agent = await auth.ResolveAsync(context.HttpContext, context.HttpContext.RequestAborted);

        if (agent is null)
        {
            return ConnectorResults.Error(new ConnectorHttpException(
                StatusCodes.Status401Unauthorized,
                ConnectorException.InvalidRequest("unknown or revoked agent")));
        }

        context.HttpContext.Items[ItemKey] = agent;
        return await next(context);
    }
}

public static class AgentContextExtensions
{
    public static AgentRow RequireAgent(this HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);
        return http.Items[AgentAuthFilter.ItemKey] as AgentRow
               ?? throw ConnectorException.InvalidRequest("no agent on this request");
    }
}
