using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Transport;

/// <summary>
/// The agent's whole view of the control plane: eleven calls, all outbound.
///
/// There is no inbound surface here by design - that is what lets an agent sit
/// behind NAT on a residential line or on a user's own machine with no port
/// open and no redesign for the bring-your-own case. The live view keeps that
/// property rather than spending it: a stream that looks like it needs a socket
/// dialled INTO the agent is a POST out per frame and a long poll out for what
/// comes back.
/// </summary>
public sealed class ControlPlaneClient
{
    public const string ClientName = "connector-agent-control-plane";

    /// <summary>
    /// The same control plane on a much shorter clock, for the two calls that
    /// have to FAIL IN TIME TO BE TRIED AGAIN: the lease renewal, which is
    /// holding a job, and the heartbeat, which is holding this agent's place in
    /// the fleet.
    /// </summary>
    /// <remarks>
    /// Every other call here is either a long poll, which is meant to hang, or
    /// one whose lateness costs only itself. These two are measured by somebody
    /// else's clock - the control plane's lease expiry and its liveness window
    /// - and on the long polls' seventy-second bound they were abandoned after
    /// that clock had already run out. The bound, and the arithmetic behind it,
    /// is <c>ConnectorAgentOptions.KeepaliveTimeout</c>.
    /// </remarks>
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

    /// <param name="connection">
    /// Which connector's clients to call on. A client carries the base
    /// address, the certificate authority to trust and the bearer token of one
    /// connector, so an agent serving several registers a pair per connection
    /// and each client of this class asks for its own by name. The default is
    /// the single-connector deployment, whose connection is called
    /// <see cref="ConnectorConnection.DefaultName"/>.
    /// </param>
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

    /// <summary>The long polls' client for one connector.</summary>
    public static string ClientNameFor(string? connection) =>
        $"{ClientName}#{connection ?? ConnectorConnection.DefaultName}";

    /// <summary>The keepalives' client for one connector.</summary>
    public static string KeepaliveClientNameFor(string? connection) =>
        $"{KeepaliveClientName}#{connection ?? ConnectorConnection.DefaultName}";

    public async Task<EnrollResponse> EnrollAsync(EnrollRequest request, CancellationToken ct)
    {
        using var response = await PostAsync("agent/v1/enroll", request, ct).ConfigureAwait(false);
        EnsureSuccess(response, "enroll");
        return await ReadAsync<EnrollResponse>(response, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Tells the control plane this agent is alive, on the keepalive client's
    /// clock: a beat that hangs has to be abandoned and re-sent inside the
    /// window the far end uses to decide whether anyone may be sent here.
    /// </summary>
    public async Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct)
    {
        using var response = await PostAsync(_keepaliveClientName, "agent/v1/heartbeat", request, ct)
            .ConfigureAwait(false);
        EnsureSuccess(response, "heartbeat");
        return await ReadAsync<HeartbeatResponse>(response, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Long-polls for work. Null means the poll came back empty and the agent
    /// should simply ask again - not an error, and not a reason to back off.
    /// </summary>
    public async Task<LeasedJob?> LeaseAsync(LeaseRequest request, CancellationToken ct)
    {
        using var response = await PostAsync("agent/v1/jobs/lease", request, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NoContent) return null;
        EnsureSuccess(response, "lease");
        return await ReadAsync<LeasedJob>(response, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Extends the lease on a running job. False means the control plane no
    /// longer believes we hold it, and the job must stop: continuing would let
    /// two agents drive the same login.
    /// </summary>
    public async Task<bool> RenewAsync(string jobId, CancellationToken ct)
    {
        var path = JobPath(jobId, "renew");

        // The keepalive client, because the lease this call is extending is
        // itself the deadline: giving up on a renew after the long polls'
        // seventy seconds is giving up after the lease has already lapsed and
        // the job has been handed to somebody else.
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
            // As for the frame POST and both long polls: nobody asked us to
            // stop; the HTTP client gave up. It arrives as a
            // TaskCanceledException, which IS an OperationCanceledException,
            // and that is the one type the renewal loop reads as "the job
            // finished". So one renew that stalled past the client's timeout
            // ended renewal for good, silently, while the adapter went on
            // driving the job - and a minute later the control plane took the
            // lease back from an agent still holding the browser. Named as
            // what it is, and transient, so the loop counts it as a dropped
            // connection and simply tries again next round.
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

    /// <summary>
    /// Long-polls for the human's answer. Null means "not yet"; a control plane
    /// that has already expired the challenge answers with 408 or 410, which
    /// surfaces as <see cref="ErrorCode.ChallengeExpired"/> so the job fails
    /// cleanly instead of pinning a browser for the full job timeout.
    /// </summary>
    public async Task<ChallengeAnswer?> PollAnswerAsync(
        string jobId, CancellationToken ct, string? challengeId = null)
    {
        // Named so the control plane returns the answer to THIS question. A job
        // with two open challenges would otherwise be handed whichever was
        // raised most recently.
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
            // The same translation the live methods do, and it matters more
            // here because of what the caller does without it.
            //
            // AskAsync catches OperationCanceledException and turns it into
            // MfaTimeout - "nobody answered challenge X before <expiry>". So a
            // dropped connection while somebody was reading an SMS ended the
            // challenge and blamed THEM for it, three lines below a handler
            // that exists to retry a transient failure precisely because "a
            // human answering an SMS code takes minutes, and a home line drops
            // connections in that time". Named as what it is, and transient, so
            // it is retried and counted like any other transport failure.
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

    /// <summary>
    /// Posts one live-view frame, replacing whatever the control plane is
    /// holding for this job.
    ///
    /// False means the channel is gone - no such job, or the live view has been
    /// revoked - and the caller must stop the shutter rather than retry. That
    /// distinction is the whole reason this returns a bool instead of throwing
    /// on every non-success: a stream posts many times a second, so "give up"
    /// and "the network blinked" cannot be the same answer, and an exception
    /// per frame would drown the log line that says which one it was.
    ///
    /// The bytes are the body, raw. Not base64 in JSON: a third of a live
    /// view's bandwidth is not worth spending to make a frame look like every
    /// other call, and nothing about a JPEG needs escaping.
    /// </summary>
    public async Task<bool> PostLiveFrameAsync(string jobId, LiveFrame frame, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(frame);

        var path = JobPath(jobId, "live/frame");
        var client = _factory.CreateClient(_clientName);

        using var content = new ByteArrayContent(frame.Bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");

        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };

        // The sequence and the size ride as headers rather than in the body
        // because the body IS the picture. The size is the size the frame was
        // actually taken at, and it travels with every frame - a viewer that
        // rotated a phone, or a provider that re-rendered at a different size,
        // otherwise misplaces every event the human makes afterwards, silently.
        request.Headers.TryAddWithoutValidation(
            SequenceHeader, frame.Sequence.ToString(CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation(
            SizeHeader, string.Create(CultureInfo.InvariantCulture, $"{frame.Width}x{frame.Height}"));

        // Optional, and omitted rather than sent empty when the agent could not
        // establish one: an absent header reads as "unknown origin" at the far
        // end, which is the truth, whereas a blank one invites being treated as
        // a value.
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
            // Nobody asked us to stop; the HTTP client gave up. It arrives as a
            // TaskCanceledException, which is an OperationCanceledException, so
            // a caller that reads it as cancellation quietly ends a stream a
            // human is still typing into. Named as what it is, and transient, so
            // it is retried and counted like any other transport failure.
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"POST {path} timed out before the control plane answered", ex);
        }

        using var _ = response;

        if (response.IsSuccessStatusCode) return true;

        // A 4xx is a verdict about this channel: the job is finished, the
        // capability was revoked, or nobody is watching. Stop, quietly.
        if ((int)response.StatusCode is >= 400 and < 500) return false;

        throw new ControlPlaneException(response.StatusCode, $"live frame {frame.Sequence} of job {jobId} was refused");
    }

    /// <summary>
    /// Long-polls for what the human did. Null means the window closed with
    /// nothing in it, which is the normal state of a login form nobody is
    /// touching - not an error and not a reason to back off.
    /// </summary>
    /// <param name="after">
    /// The highest event sequence this agent has already been handed. The
    /// cursor is the agent's own, so a re-delivered batch arrives with nothing
    /// newer in it and is dropped on this side too: an Enter delivered twice is
    /// a second credential submission on a page that counts attempts.
    /// </param>
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
            // As for the frame POST: the client's own timeout is not the caller
            // stopping the stream, and a long poll is exactly the call most
            // likely to hit it.
            throw new ControlPlaneException(
                HttpStatusCode.RequestTimeout, $"GET {path} timed out before the control plane answered", ex);
        }

        using var _ = response;

        if (response.StatusCode == HttpStatusCode.NoContent) return null;

        EnsureSuccess(response, "live input");
        return await ReadAsync<LiveInputBatch>(response, ct).ConfigureAwait(false);
    }

    public async Task ResultAsync(string jobId, JobResultRequest result, CancellationToken ct)
    {
        using var response = await PostAsync(JobPath(jobId, "result"), result, ct).ConfigureAwait(false);
        EnsureSuccess(response, "result");
    }

    /// <summary>
    /// Reports a job failed, and answers what the control plane RECORDED.
    /// </summary>
    /// <remarks>
    /// The state was always on the wire and always discarded here. It is the
    /// difference between a job that is over and one the queue has put back:
    /// an agent that signed a session out on attempt one would hand attempt two
    /// a dead cookie jar, turning one internal fault into an expired session
    /// and costing the account holder a second sign-in for a reason we invented.
    /// <para>
    /// An unreadable answer is <c>null</c> rather than a guess. Not knowing what
    /// happened is not a licence to end somebody's session.
    /// </para>
    /// </remarks>
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
            // The translation the renew, the frame POST and both long polls
            // each make for themselves, made here so that every JSON POST makes
            // it too. It matters most for the heartbeat, which now has a bound
            // it is expected to hit: unnamed, a client that gave up arrives as
            // the same TaskCanceledException a shutdown does, and the only
            // thing telling the loop apart is one filter asking whose token
            // fired. That filter is right, and it is also the whole margin -
            // the renew had the same shape and the reading it got there ended
            // renewal for good. Named as what it is, the answer no longer
            // depends on it, and the log line says "timed out" rather than
            // nothing at all.
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
