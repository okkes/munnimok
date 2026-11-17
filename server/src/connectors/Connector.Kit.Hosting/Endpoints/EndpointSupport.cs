using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Endpoints;

/// the outermost filter: no unmodelled failure gets past it, so "never a bare 500" is structural
public sealed class ConnectorExceptionFilter(ILoggerFactory loggers) : IEndpointFilter
{
    private readonly ILogger _logger = loggers.CreateLogger("Connector.Endpoints");

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        try
        {
            return await next(context);
        }
        catch (Exception ex)
        {
            // a started response cannot take an envelope (SSE and image streams): aborting is the only signal left
            if (context.HttpContext.Response.HasStarted)
            {
                _logger.LogError(ex, "failure after the response had started; aborting");
                context.HttpContext.Abort();
                return null;
            }

            return ConnectorResults.FromException(ex, _logger);
        }
    }
}

public static class RequestContext
{
    public const string DeviceClassHeader = "X-Device-Class";
    public const string TicketHeader = "X-Connector-Ticket";
    public const string ManifestVersionHeader = "X-Manifest-Version";
    public const string IdempotencyHeader = "Idempotency-Key";

    /// absent means native: the historical default, safe as the web rules only shorten a bundle's life
    /// anything else is rejected
    public static DeviceClass DeviceClassOf(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        var raw = http.Request.Headers[DeviceClassHeader].ToString();
        if (string.IsNullOrWhiteSpace(raw)) return DeviceClass.Native;

        return raw.Trim().ToLowerInvariant() switch
        {
            "native" => DeviceClass.Native,
            "web" => DeviceClass.Web,
            _ => throw ConnectorException.InvalidRequest($"{DeviceClassHeader} must be 'native' or 'web'"),
        };
    }

    public static string RequireTicket(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        var ticket = http.Request.Headers[TicketHeader].ToString();
        return string.IsNullOrWhiteSpace(ticket)
            ? throw ConnectorException.InvalidRequest($"{TicketHeader} is required")
            : ticket;
    }

    public const string SubjectHeader = "X-Connector-Subject";
    public const string TriggerHeader = "X-Connector-Trigger";

    /// every route naming a session, job, ticket or agent answers only its owner; "not yours" looks like "does not exist"
    /// the header is required: a relay that forgot it would silently read everything
    public static string RequireSubject(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        var subject = http.Request.Headers[SubjectHeader].ToString().Trim();
        return subject.Length == 0
            ? throw ConnectorException.InvalidRequest($"{SubjectHeader} is required")
            : subject;
    }

    /// a body that names the subject may also carry the header; they must agree or the call is refused
    public static void RequireSubjectAgreement(HttpContext http, string bodySubject)
    {
        ArgumentNullException.ThrowIfNull(http);

        var header = http.Request.Headers[SubjectHeader].ToString().Trim();
        if (header.Length > 0 && !string.Equals(header, bodySubject, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidRequest($"{SubjectHeader} does not name the subject in the body");
        }
    }

    /// absent means a person: the historical default, never throttled by a provider's sync interval
    public static string TriggerNameOf(HttpContext http) => TriggerOf(http) switch
    {
        FetchTrigger.Schedule => JobRow.ScheduleTrigger,
        FetchTrigger.Backfill => JobRow.BackfillTrigger,
        FetchTrigger.Lab => JobRow.LabTrigger,
        _ => JobRow.UserTrigger,
    };

    /// recorded only when asked AND the caller is the lab; the flag without the lab trigger is refused, not ignored
    public static bool RecordOf(HttpContext http, bool requested)
    {
        if (!requested) return false;

        if (TriggerOf(http) != FetchTrigger.Lab)
        {
            throw ConnectorException.InvalidRequest("recording a run is the lab's alone");
        }

        return true;
    }

    /// <summary>An operator-only provider (#441 L3) answers the lab's trigger and nobody else's.</summary>
    public static void RequireOperatorsDoor(HttpContext http, Manifests.ProviderManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        if (manifest.OperatorOnly && TriggerOf(http) != FetchTrigger.Lab)
        {
            throw ConnectorException.Unsupported($"provider '{manifest.Id}' is the operator's alone");
        }
    }

    public static FetchTrigger TriggerOf(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        var raw = http.Request.Headers[TriggerHeader].ToString();
        if (string.IsNullOrWhiteSpace(raw)) return FetchTrigger.User;

        return raw.Trim().ToLowerInvariant() switch
        {
            "user" => FetchTrigger.User,
            "schedule" => FetchTrigger.Schedule,
            "backfill" => FetchTrigger.Backfill,
            // "lab" is the operator's word only: a lab run's failure pictures are retained without asking,
            // so a consumer claiming it would claim a person's consent; in development everybody is the operator
            "lab" => http.RequestServices.GetRequiredService<Auth.ConnectorAuth>().IsOperator(http)
                ? FetchTrigger.Lab
                : throw ConnectorException.InvalidRequest($"{TriggerHeader} 'lab' needs the admin scope"),
            _ => throw ConnectorException.InvalidRequest($"{TriggerHeader} must be 'user', 'schedule', 'backfill' or 'lab'"),
        };
    }

    public static void StampManifestVersion(HttpContext http, int manifestVersion)
    {
        ArgumentNullException.ThrowIfNull(http);
        http.Response.Headers[ManifestVersionHeader] =
            manifestVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    public static string? IdempotencyKey(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);
        var key = http.Request.Headers[IdempotencyHeader].ToString();
        return string.IsNullOrWhiteSpace(key) ? null : key;
    }

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Query(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        var result = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var (key, values) in http.Request.Query)
        {
            result[key] = [.. values.Where(v => v is not null).Select(v => v!)];
        }

        return result;
    }
}

/// the stream re-reads state and emits on change, holding no subscription
/// a reconnecting consumer sees the current truth at once
public enum FetchTrigger
{
    /// <summary>A person, just now. Held to the provider's request pacing only.</summary>
    User,

    /// <summary>A schedule. Held to the provider's <c>min_interval_seconds</c> as well.</summary>
    Schedule,

    /// a schedule's pass over older history (#460): unattended, held to the same interval on its own clock
    /// a party sees one of each per interval
    Backfill,

    /// <summary>The operator's lab (#441): paced like a person's, and its failures are the operator's own to read.</summary>
    Lab,
}

public static class EventStream
{
    public static async Task WriteAsync<TState>(
        HttpContext http,
        Func<CancellationToken, Task<TState?>> read,
        Func<TState, bool> isFinal,
        ConnectorSignals signals,
        string signalKey,
        TimeSpan maximum,
        CancellationToken ct)
        where TState : class
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(read);
        ArgumentNullException.ThrowIfNull(isFinal);
        ArgumentNullException.ThrowIfNull(signals);

        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        // Buffering an event stream turns live progress into a single blob at
        // the end, which is the one thing it must not be.
        http.Response.Headers["X-Accel-Buffering"] = "no";

        var deadline = DateTimeOffset.UtcNow + maximum;
        string? last = null;

        // a vanished reader is the ordinary end of a stream: letting it escape made the error middleware write an envelope
        // onto a started response, and "Headers are read-only" buried the cause. The stream carries no state; a client re-reads rows
        try
        {
            while (!ct.IsCancellationRequested && DateTimeOffset.UtcNow < deadline)
            {
                var state = await read(ct);
                if (state is null) break;

                var rendered = ConnectorJson.Serialize(state);
                if (!string.Equals(rendered, last, StringComparison.Ordinal))
                {
                    await Emit(http, "state", rendered, ct);
                    last = rendered;
                }

                if (isFinal(state)) break;

                if (!await signals.WaitAsync(signalKey, TimeSpan.FromSeconds(5), ct))
                {
                    // a comment frame keeps proxies and load balancers from reaping an idle stream during a long bank login
                    await Emit(http, null, null, ct);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // the request was aborted or the caller's token fired
        }
        catch (IOException)
        {
            // the socket went mid-frame; Kestrel's ConnectionResetException arrives as one of these
        }
    }

    private static async Task Emit(HttpContext http, string? name, string? data, CancellationToken ct)
    {
        var frame = new StringBuilder();
        if (name is null)
        {
            frame.Append(": keep-alive\n\n");
        }
        else
        {
            frame.Append("event: ").Append(name).Append('\n');
            frame.Append("data: ").Append(data).Append("\n\n");
        }

        await http.Response.WriteAsync(frame.ToString(), Encoding.UTF8, ct);
        await http.Response.Body.FlushAsync(ct);
    }
}
