using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Tracing;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Transport;

/// outbound calls only, by design: an agent sits behind NAT with no open port; the live view is POST out plus long poll out
public sealed class ControlPlaneClient
{
    public const string ClientName = "connector-agent-control-plane";

    /// shorter clock for lease renewal and heartbeat, which must fail in time to be retried: the long polls' 70s bound
    /// outlives the control plane's lease and liveness windows (see ConnectorAgentOptions.KeepaliveTimeout)
    public const string KeepaliveClientName = ClientName + "-keepalive";

    /// <summary>Monotonic per job, so a viewer showing frame 40 ignores 39 arriving late.</summary>
    public const string SequenceHeader = "X-Live-Sequence";

    /// <summary><c>WIDTHxHEIGHT</c>, the size these bytes really are.</summary>
    public const string SizeHeader = "X-Live-Size";

    /// <summary>Whose page these bytes are of. Absent means the agent could not tell.</summary>
    public const string OriginHeader = "X-Live-Origin";

    private readonly IHttpClientFactory _factory;
    private readonly ILogger<ControlPlaneClient> _logger;
    private readonly string _clientName;
    private readonly string _keepaliveClientName;

    public ControlPlaneClient(
        IHttpClientFactory factory,
        ILogger<ControlPlaneClient> logger,
        string? connection = null)
    {
        ArgumentNullException.ThrowIfNull(factory);
        ArgumentNullException.ThrowIfNull(logger);

        _factory = factory;
        _logger = logger;
        _clientName = ClientNameFor(connection);
        _keepaliveClientName = KeepaliveClientNameFor(connection);
    }

    public static string ClientNameFor(string? connection) =>
        $"{ClientName}#{connection ?? ConnectorConnection.DefaultName}";

    public static string KeepaliveClientNameFor(string? connection) =>
        $"{KeepaliveClientName}#{connection ?? ConnectorConnection.DefaultName}";

    public async Task<EnrollResponse> EnrollAsync(EnrollRequest request, CancellationToken ct)
    {
        using var response = await PostAsync("agent/v1/enroll", request, ct).ConfigureAwait(false);
        EnsureSuccess(response, "enroll");
        return await ReadAsync<EnrollResponse>(response, ct).ConfigureAwait(false);
    }

    /// on the keepalive client's clock: a hung beat must be re-sent inside the control plane's liveness window
    public async Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct)
    {
        using var response = await PostAsync(_keepaliveClientName, "agent/v1/heartbeat", request, ct)
            .ConfigureAwait(false);
        EnsureSuccess(response, "heartbeat");
        return await ReadAsync<HeartbeatResponse>(response, ct).ConfigureAwait(false);
    }

    /// null = empty poll: ask again, no back-off
    public async Task<LeasedJob?> LeaseAsync(LeaseRequest request, CancellationToken ct)
    {
        using var response = await PostAsync("agent/v1/jobs/lease", request, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NoContent) return null;
        EnsureSuccess(response, "lease");
        return await ReadAsync<LeasedJob>(response, ct).ConfigureAwait(false);
    }

    /// false = the control plane no longer believes we hold the job; it must stop, or two agents drive the same login
    public async Task<bool> RenewAsync(string jobId, CancellationToken ct)
    {
        var path = JobPath(jobId, "renew");

        // keepalive client: the lease being renewed is the deadline, and the long polls' 70s bound outlasts it
        var client = _factory.CreateClient(_keepaliveClientName);

        HttpResponseMessage response;
        try
        {
            response = await client.PostAsync(path, content: null, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ControlPlaneException(ex.StatusCode, $"POST {path} did not reach the control plane", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // a client timeout is a TaskCanceledException, which the renewal loop reads as "job finished" and stopped renewing
            // for good; named transient so the loop retries
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"POST {path} timed out before the control plane answered", ex);
        }

        using var _ = response;

        if (response.IsSuccessStatusCode) return true;

        // A 4xx is a verdict; a 5xx is the control plane having a bad moment
        // and must not kill a job that is otherwise going fine.
        if ((int)response.StatusCode is >= 400 and < 500) return false;

        throw new ControlPlaneException(response.StatusCode, $"renew of job {jobId} failed");
    }

    public async Task ProgressAsync(string jobId, ProgressReport report, CancellationToken ct)
    {
        using var response = await PostAsync(JobPath(jobId, "progress"), report, ct).ConfigureAwait(false);
        EnsureSuccess(response, "progress");
    }

    public async Task<RaiseChallengeResponse> RaiseChallengeAsync(
        string jobId, RaiseChallengeRequest request, CancellationToken ct)
    {
        using var response = await PostAsync(JobPath(jobId, "challenge"), request, ct).ConfigureAwait(false);
        EnsureSuccess(response, "challenge");
        return await ReadAsync<RaiseChallengeResponse>(response, ct).ConfigureAwait(false);
    }

    /// null = not yet; 408 or 410 means the control plane expired it: surfaced as ChallengeExpired so the job fails
    /// cleanly instead of pinning a browser
    public async Task<ChallengeAnswer?> PollAnswerAsync(
        string jobId, CancellationToken ct, string? challengeId = null)
    {
        // named so a job with two open challenges gets the answer to this one, not the newest
        var path = JobPath(jobId, "answer");
        if (!string.IsNullOrWhiteSpace(challengeId))
        {
            path += $"?challenge_id={Uri.EscapeDataString(challengeId)}";
        }
        var client = _factory.CreateClient(_clientName);

        HttpResponseMessage response;
        try
        {
            response = await client.GetAsync(path, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ControlPlaneException(ex.StatusCode, $"GET {path} did not reach the control plane", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // AskAsync turns an OperationCanceledException into MfaTimeout, blaming the human for a dropped connection;
            // named transient so it is retried
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"GET {path} timed out before the control plane answered", ex);
        }

        using var _ = response;

        if (response.StatusCode == HttpStatusCode.NoContent) return null;

        if (response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.Gone)
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired,
                $"the control plane expired the challenge on job {jobId}");
        }

        EnsureSuccess(response, "answer");
        return await ReadAsync<ChallengeAnswer>(response, ct).ConfigureAwait(false);
    }

    /// false = channel gone (no such job, live view revoked): stop, do not retry; a bool because frames post many times a second
    /// the bytes are the raw body, not base64: saves a third of the bandwidth
    public async Task<bool> PostLiveFrameAsync(string jobId, LiveFrame frame, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(frame);

        var path = JobPath(jobId, "live/frame");
        var client = _factory.CreateClient(_clientName);

        using var content = new ByteArrayContent(frame.Bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");

        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };

        // the size the frame was taken at travels with every frame: a rotated phone or re-rendered page would misplace events
        request.Headers.TryAddWithoutValidation(
            SequenceHeader, frame.Sequence.ToString(CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation(
            SizeHeader, string.Create(CultureInfo.InvariantCulture, $"{frame.Width}x{frame.Height}"));

        // omitted rather than blank when unknown: absent reads as "unknown origin", blank would be taken as a value
        if (frame.Origin is { Length: > 0 } origin)
        {
            request.Headers.TryAddWithoutValidation(OriginHeader, origin);
        }

        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ControlPlaneException(ex.StatusCode, $"POST {path} did not reach the control plane", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // a client timeout is a TaskCanceledException; named transient so it is not read as cancellation that ends the stream
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"POST {path} timed out before the control plane answered", ex);
        }

        using var _ = response;

        if (response.IsSuccessStatusCode) return true;

        // a 4xx is a verdict about this channel (job finished, capability revoked, nobody watching): stop quietly
        if ((int)response.StatusCode is >= 400 and < 500) return false;

        throw new ControlPlaneException(response.StatusCode, $"live frame {frame.Sequence} of job {jobId} was refused");
    }

    /// null = the window closed with nothing in it (normal); after is the agent's own cursor, so a re-delivered batch
    /// is dropped: an Enter delivered twice is a second credential submission
    public async Task<LiveInputBatch?> PollLiveInputAsync(string jobId, long after, CancellationToken ct)
    {
        var path = JobPath(jobId, "live/input") + $"?after={after.ToString(CultureInfo.InvariantCulture)}";
        var client = _factory.CreateClient(_clientName);

        HttpResponseMessage response;
        try
        {
            response = await client.GetAsync(path, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ControlPlaneException(ex.StatusCode, $"GET {path} did not reach the control plane", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // the client's own timeout is not the caller stopping; a long poll is the call most likely to hit it
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"GET {path} timed out before the control plane answered", ex);
        }

        using var _ = response;

        if (response.StatusCode == HttpStatusCode.NoContent) return null;

        EnsureSuccess(response, "live input");
        return await ReadAsync<LiveInputBatch>(response, ct).ConfigureAwait(false);
    }

    public const string TraceEntriesHeader = "X-Trace-Entries";

    public const string TraceDroppedHeader = "X-Trace-Dropped";

    /// gzipped JSON (#441 L3): a trace can weigh megabytes and HTML compresses ten to one; sent before the result
    public async Task PostTraceAsync(string jobId, JobTrace trace, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(trace);

        var path = JobPath(jobId, "trace");
        var client = _factory.CreateClient(_clientName);

        using var packed = new MemoryStream();
        await using (var zip = new System.IO.Compression.GZipStream(packed, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true))
        {
            await JsonSerializer.SerializeAsync(zip, trace, AgentJson.Options, ct).ConfigureAwait(false);
        }

        using var content = new ByteArrayContent(packed.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        content.Headers.ContentEncoding.Add("gzip");

        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
        request.Headers.TryAddWithoutValidation(TraceEntriesHeader, trace.Entries.Count.ToString(CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation(TraceDroppedHeader, trace.Dropped.ToString(CultureInfo.InvariantCulture));

        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ControlPlaneException(ex.StatusCode, $"POST {path} did not reach the control plane", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"POST {path} timed out before the control plane answered", ex);
        }

        using (response) EnsureSuccess(response, "trace");
    }

    public async Task ResultAsync(string jobId, JobResultRequest result, CancellationToken ct)
    {
        using var response = await PostAsync(JobPath(jobId, "result"), result, ct).ConfigureAwait(false);
        EnsureSuccess(response, "result");
    }

    /// answers the state the control plane recorded: a job the queue put back must not have its session signed out
    /// an unreadable answer is null, not a guess
    public async Task<JobState?> FailAsync(string jobId, JobFailRequest failure, CancellationToken ct)
    {
        using var response = await PostAsync(JobPath(jobId, "fail"), failure, ct).ConfigureAwait(false);
        EnsureSuccess(response, "fail");

        try
        {
            var recorded = await response.Content
                .ReadFromJsonAsync<AgentFailResponse>(AgentJson.Options, ct).ConfigureAwait(false);

            return recorded?.State;
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException)
        {
            return null;
        }
    }

    private Task<HttpResponseMessage> PostAsync<T>(string path, T body, CancellationToken ct) =>
        PostAsync(_clientName, path, body, ct);

    private async Task<HttpResponseMessage> PostAsync<T>(
        string clientName, string path, T body, CancellationToken ct)
    {
        var client = _factory.CreateClient(clientName);
        try
        {
            return await client.PostAsJsonAsync(path, body, AgentJson.Options, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ControlPlaneException(ex.StatusCode, $"POST {path} did not reach the control plane", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // same translation for every JSON POST: the heartbeat has a bound it is expected to hit, and an unnamed timeout
            // looks like a shutdown's TaskCanceledException
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"POST {path} timed out before the control plane answered", ex);
        }
    }

    private static string JobPath(string jobId, string action) =>
        $"agent/v1/jobs/{Uri.EscapeDataString(jobId)}/{action}";

    private static void EnsureSuccess(HttpResponseMessage response, string what)
    {
        if (response.IsSuccessStatusCode) return;
        throw new ControlPlaneException(response.StatusCode, $"{what} returned {(int)response.StatusCode}");
    }

    private async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            return await response.Content.ReadFromJsonAsync<T>(AgentJson.Options, ct).ConfigureAwait(false)
                   ?? throw new ControlPlaneException(response.StatusCode, $"empty {typeof(T).Name} body");
        }
        catch (System.Text.Json.JsonException ex)
        {
            _logger.LogError(ex, "the control plane sent a {Type} this agent cannot read", typeof(T).Name);
            throw new ControlPlaneException(response.StatusCode, $"malformed {typeof(T).Name} body", ex);
        }
    }
}
