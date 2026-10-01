using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Munni.Api.Sync;

namespace Munni.Api.Connectors;

/// <summary>
/// Bridges a connector's event stream into munni's own (docs/connector-
/// integration-plan.md §5.4). A login or a job the user is waiting on has a
/// stream on the control plane; the relay reads it and republishes every
/// view — minus anything a bundle rides in — on <c>/sync/events</c> for that
/// user as <c>{ kind: "connector", … }</c>. The client already holds that
/// stream, so there is no second EventSource and no CORS.
///
/// One bridge per session or job, started by the relay whenever it answers
/// with a run still in flight, held at most the control plane's own ten
/// minutes, and gone the moment the view is terminal. Nothing is stored:
/// every frame is a projection of rows the client can re-read.
/// </summary>
public sealed class ConnectorEventBridge(
    IServiceScopeFactory scopes,
    SpaceEventBroadcaster events,
    ILogger<ConnectorEventBridge> logger)
{
    public const string Kind = "connector";

    private static readonly TimeSpan Maximum = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, Task> _running = new(StringComparer.Ordinal);

    /// <summary>How many bridges are open right now — for the operator's status line and the tests.</summary>
    public int Open => _running.Count;

    /// <summary>Starts following a login session's stream, unless it is already followed.</summary>
    public void WatchSession(Guid userId, string subject, string provider, string sessionId) =>
        Start(sessionId, userId, subject, provider, sessionId, jobId: null);

    /// <summary>Starts following a job's stream, unless it is already followed.</summary>
    public void WatchJob(Guid userId, string subject, string provider, string sessionId, string jobId) =>
        Start(jobId, userId, subject, provider, sessionId, jobId);

    /// <summary>The frame the app receives, built from the connector's view.</summary>
    public static string Frame(string provider, string sessionId, string? jobId, JsonObject view)
    {
        var frame = ConnectorJson.WithoutSecrets(view);
        frame.Remove("data"); // a page of records never rides the stream
        frame["kind"] = Kind;
        frame["provider"] = provider;
        frame["sessionId"] = sessionId;
        if (jobId is not null) frame["jobId"] = jobId;
        return frame.ToJsonString();
    }

    private void Start(string key, Guid userId, string subject, string provider, string sessionId, string? jobId)
    {
        if (_running.ContainsKey(key)) return;

        var task = Task.Run(() => RunAsync(key, userId, subject, provider, sessionId, jobId));
        if (!_running.TryAdd(key, task))
        {
            // lost the race to a bridge started a moment ago — that one carries the stream
        }
    }

    private async Task RunAsync(string key, Guid userId, string subject, string provider, string sessionId, string? jobId)
    {
        try
        {
            using var lifetime = new CancellationTokenSource(Maximum);
            using var scope = scopes.CreateScope();
            var client = scope.ServiceProvider.GetRequiredService<ConnectorClient>();
            var path = jobId is null
                ? $"v1/{provider}/login/{sessionId}/events"
                : $"v1/{provider}/jobs/{jobId}/events";

            using var response = await client.OpenStreamAsync(path, new ConnectorCall { Subject = subject }, lifetime.Token);
            if (!response.IsSuccessStatusCode)
            {
                Note(key, "answered " + ((int)response.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture), null);
                return;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(lifetime.Token);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            await PumpAsync(reader, userId, provider, sessionId, jobId, lifetime.Token);
        }
        catch (OperationCanceledException)
        {
            // the ten minutes are up, or the process is stopping
        }
        catch (HttpRequestException ex)
        {
            Note(key, "ended badly", ex);
        }
        catch (IOException ex)
        {
            Note(key, "broke", ex);
        }
        finally
        {
            _running.TryRemove(key, out _);
        }
    }

    /// <summary>A stream that stopped is not an incident — the client re-reads the rows — so this is debug, and only when somebody listens.</summary>
    private void Note(string key, string what, Exception? ex)
    {
        if (!logger.IsEnabled(LogLevel.Debug)) return;
        logger.LogDebug(ex, "connector stream for {Key} {What}", key, what);
    }

    /// <summary>Reads server-sent events: <c>event: state</c> + <c>data: …</c>, blank line between frames, comments skipped.</summary>
    private async Task PumpAsync(StreamReader reader, Guid userId, string provider, string sessionId, string? jobId, CancellationToken ct)
    {
        string? eventName = null;
        var data = new StringBuilder();

        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0)
            {
                if (string.Equals(eventName, "state", StringComparison.Ordinal) && data.Length > 0)
                {
                    Publish(userId, provider, sessionId, jobId, data.ToString());
                }
                eventName = null;
                data.Clear();
                continue;
            }

            if (line[0] == ':') continue;
            if (line.StartsWith("event:", StringComparison.Ordinal)) eventName = line[6..].Trim();
            else if (line.StartsWith("data:", StringComparison.Ordinal)) data.Append(line[5..].TrimStart());
        }
    }

    private void Publish(Guid userId, string provider, string sessionId, string? jobId, string json)
    {
        JsonObject? view;
        try
        {
            view = ConnectorJson.ToCamel(JsonNode.Parse(json)) as JsonObject;
        }
        catch (System.Text.Json.JsonException)
        {
            return; // a frame that is not JSON is nobody's contract
        }

        if (view is null) return;
        events.PublishToUser(userId, Frame(provider, sessionId, jobId, view));
    }
}
