using System.Globalization;
using System.Net;
using System.Text;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;

namespace Connector.Kit.Agent.Tests;

// stubbed at the socket, not a mock of the sealed ControlPlaneClient: its status rules (4xx renew = verdict,
// 5xx = bad moment) stay tested
internal sealed class FakeControlPlane : HttpMessageHandler, IHttpClientFactory
{
    // an empty long poll waits briefly before 204: zero would spin the polling loop and drown the timings under test
    private static readonly TimeSpan PollWindow = TimeSpan.FromMilliseconds(50);

    // read from the options, not restated: a default changed in ConnectorAgentOptions must move the tests with it
    private static readonly ConnectorAgentOptions Shipped = new();

    private readonly Lock _gate = new();
    private readonly List<EnrollRequest> _enrollments = [];
    private readonly List<JobFailRequest> _failures = [];
    private readonly List<DateTimeOffset> _renewedAt = [];
    private readonly List<DateTimeOffset> _beatsAt = [];
    private readonly List<Abandoned> _abandoned = [];

    private readonly Queue<LeasedJob> _queued = new();

    public void Enqueue(params LeasedJob[] jobs)
    {
        ArgumentNullException.ThrowIfNull(jobs);
        lock (_gate) foreach (var job in jobs) _queued.Enqueue(job);
    }

    // Queued is the retriable case: the job is not over, and tidying up would hand the next attempt a dead session
    public JobState FailState { get; set; } = JobState.Failed;
    private readonly List<JobResultRequest> _results = [];
    private readonly List<PostedFrame> _frames = [];
    private readonly List<ProgressReport> _progress = [];
    private readonly Queue<LiveInputBatch> _pendingInput = new();

    private int _challengesRaised;
    private ChallengeAnswer? _answer;
    private RaiseChallengeRequest? _raised;
    private long _highestSequence;
    private int _discardedFrames;
    private int _stallFrames;
    private int _stallInputPolls;
    private int _stallRenewals;
    private int _stallHeartbeats;
    private int _answerBlips;
    private int _inputPolls;

    internal readonly record struct PostedFrame(long Sequence, string? Size, int Bytes, string? Origin);

    // Bound is which client the call went out on; Held is what it cost; they agree to within one clock step
    internal readonly record struct Abandoned(string Path, TimeSpan Bound, TimeSpan Held);

    public void Answer(string value = "solved", string challengeId = "chl_test")
    {
        lock (_gate) _answer = new ChallengeAnswer { ChallengeId = challengeId, Value = value };
    }

    public void SaysNothingYet()
    {
        lock (_gate) _answer = null;
    }

    public void AnswerBlips(int count)
    {
        lock (_gate) _answerBlips = count;
    }

    /// <summary>What a posted result is answered with; a 4xx is a verdict, a 5xx an outage.</summary>
    public HttpStatusCode ResultStatus { get; set; } = HttpStatusCode.NoContent;

    public HttpStatusCode FailStatus { get; set; } = HttpStatusCode.OK;

    /// <summary>True makes every renew answer 409: the control plane no longer holds the lease for this agent.</summary>
    public bool RenewRefused { get; set; }

    public int ResultCount { get { lock (_gate) return _results.Count; } }

    // short in tests: a client timeout is a TaskCanceledException, indistinguishable from the caller stopping
    // unless whose token fired is checked
    public TimeSpan ClientTimeout { get; set; } = Shipped.ControlPlaneTimeout;

    // the keepalive client's own, much shorter bound: renew and heartbeat go on a client of their own so they are
    // abandoned in time to retry
    public TimeSpan KeepaliveTimeout { get; set; } = Shipped.KeepaliveTimeout;

    // also the key its enrollment is filed under in the state file; settable so a test can be two connectors
    public Uri BaseAddress { get; set; } = new("https://control-plane.test/");

    // its own per control plane: two connectors issue two ids to one machine, and a BYO agent's profile ids derive from it
    public string AgentId { get; set; } = "agt_" + new string('0', 32);

    public bool Revokes { get; set; }

    /// <summary>The catalogue digest this control plane claims in every heartbeat; null says nothing.</summary>
    public string? CatalogDigest { get; set; }

    // asks for a profile wipe on every beat (#420 A2, a released hosted slot) until a beat says it was done
    public bool ResetsProfiles { get; set; }

    private int _resetDoneBeats;

    public int ResetDoneBeats { get { lock (_gate) return _resetDoneBeats; } }

    /// <summary>The cadence the enrollment asks for; the agent clamps it to five seconds at least.</summary>
    public int HeartbeatSeconds { get; set; } = 30;

    // the clock for the bounds and arrival stamps; a TestClock makes a ten-second production bound bite after
    // ten virtual seconds
    public TimeProvider Time { get; set; } = TimeProvider.System;

    public void StallFrames(int count)
    {
        lock (_gate) _stallFrames = count;
    }

    public void StallInputPolls(int count)
    {
        lock (_gate) _stallInputPolls = count;
    }

    public void StallRenewals(int count)
    {
        lock (_gate) _stallRenewals = count;
    }

    // a swallowed beat costs whatever the client will wait; a refused one comes back at once
    public void StallHeartbeats(int count)
    {
        lock (_gate) _stallHeartbeats = count;
    }

    public IReadOnlyList<PostedFrame> Frames { get { lock (_gate) return [.. _frames]; } }

    public IReadOnlyList<ProgressReport> Progress { get { lock (_gate) return [.. _progress]; } }

    // the connector's rule, modelled because the agent cannot see it: one slot per job, a frame that does not advance
    // the count is discarded with 200
    public int DiscardedFrames { get { lock (_gate) return _discardedFrames; } }

    public bool LiveChannelGone { get; set; }

    public void SendLiveInput(LiveInputBatch batch)
    {
        lock (_gate) _pendingInput.Enqueue(batch);
    }

    public int PendingInput { get { lock (_gate) return _pendingInput.Count; } }

    // the agent asks again only after dealing with the last answer, so a poll counted after a batch proves it was handled
    public int InputPolls { get { lock (_gate) return _inputPolls; } }

    // a renewal the control plane was told to hang on is not counted (the client gave up): tells a renewer that
    // carried on from one that died
    public int Renewals { get { lock (_gate) return _renewedAt.Count; } }

    public IReadOnlyList<DateTimeOffset> RenewedAt { get { lock (_gate) return [.. _renewedAt]; } }

    // the gap between consecutive entries is what the control plane's liveness rule looks at
    public IReadOnlyList<DateTimeOffset> BeatsAt { get { lock (_gate) return [.. _beatsAt]; } }

    public IReadOnlyList<Abandoned> GaveUp { get { lock (_gate) return [.. _abandoned]; } }

    // proves a connector enrolled with its own code, not whichever one the process held
    public IReadOnlyList<EnrollRequest> Enrollments { get { lock (_gate) return [.. _enrollments]; } }

    public int ChallengesRaised { get { lock (_gate) return _challengesRaised; } }

    public RaiseChallengeRequest? Raised { get { lock (_gate) return _raised; } }

    public JobFailRequest? Failure { get { lock (_gate) return _failures.Count == 0 ? null : _failures[^1]; } }

    public JobResultRequest? Result { get { lock (_gate) return _results.Count == 0 ? null : _results[^1]; } }

    private readonly List<Connector.Kit.Tracing.JobTrace> _traces = [];

    public Connector.Kit.Tracing.JobTrace? Trace { get { lock (_gate) return _traces.Count == 0 ? null : _traces[^1]; } }

    public int TraceCount { get { lock (_gate) return _traces.Count; } }

    public string? FailureCode => Failure?.Code;

    /// <summary>How many terminal failure posts this job made. One, or a bug.</summary>
    public int FailureCount { get { lock (_gate) return _failures.Count; } }

    // the name is the point: the long polls' and keepalives' clients share one control plane and the choice is under test.
    // a fake with one timeout, or picking by path, would pass with the renew on the long polls' client
    public HttpClient CreateClient(string name) =>
        new(new Bounded(this, Bound(name), Time), disposeHandler: false)
        {
            BaseAddress = BaseAddress,

            // infinite here: Bounded stands in for this property, and both armed would race a real timer against a virtual one
            Timeout = Timeout.InfiniteTimeSpan,
        };

    // by prefix: names end in the connector (...-keepalive#registry); the keepalive name is the long polls' plus
    // a suffix, so test it first
    private TimeSpan Bound(string name) =>
        name.StartsWith(ControlPlaneClient.KeepaliveClientName, StringComparison.Ordinal)
            ? KeepaliveTimeout
            : ClientTimeout;

    private void GaveUpOn(string path, TimeSpan bound, TimeSpan held)
    {
        lock (_gate) _abandoned.Add(new Abandoned(path, bound, held));
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        // real HTTP never completes synchronously; a stub that does hides ordering bugs
        await Task.Yield();
        ct.ThrowIfCancellationRequested();

        var path = request.RequestUri!.AbsolutePath;

        if (path.EndsWith("agent/v1/enroll", StringComparison.Ordinal))
        {
            var enrollment = await ReadAsync<EnrollRequest>(request, ct);
            lock (_gate) _enrollments.Add(enrollment);

            return Json(System.Text.Json.JsonSerializer.Serialize(
                new EnrollResponse
                {
                    AgentId = AgentId,
                    Token = "tok_fake",
                    HeartbeatSeconds = HeartbeatSeconds,

                },
                AgentJson.Options));
        }

        if (path.EndsWith("agent/v1/heartbeat", StringComparison.Ordinal))
        {
            if (Stalling(ref _stallHeartbeats)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            var beat = await ReadAsync<HeartbeatRequest>(request, ct);
            bool askWipe;
            lock (_gate)
            {
                _beatsAt.Add(Time.GetUtcNow());
                if (beat.ResetDone)
                {
                    _resetDoneBeats++;
                    ResetsProfiles = false;
                }

                askWipe = ResetsProfiles;
            }

            // the contract's own defaults (a two-minute lease), not copied numbers
            return Json(System.Text.Json.JsonSerializer.Serialize(
                new HeartbeatResponse { Revoked = Revokes, CatalogDigest = CatalogDigest, ResetProfiles = askWipe }, AgentJson.Options));
        }

        if (path.EndsWith("agent/v1/jobs/lease", StringComparison.Ordinal))
        {
            LeasedJob? next;
            lock (_gate) next = _queued.Count > 0 ? _queued.Dequeue() : null;

            // 204 is what a real long poll answers on an empty queue
            if (next is not null) return Json(System.Text.Json.JsonSerializer.Serialize(next, AgentJson.Options));

            // answered after holding the request: an instant answer spins a host's lease loop at CPU speed
            await Task.Delay(PollWindow, Time, ct);
            return Empty(HttpStatusCode.NoContent);
        }

        // live routes first: "/live/frame" also ends with "frame", so a wrong order answers one route from another's handler
        if (path.EndsWith("/live/frame", StringComparison.Ordinal))
        {
            if (LiveChannelGone) return Empty(HttpStatusCode.Gone);
            if (Stalling(ref _stallFrames)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            var bytes = await request.Content!.ReadAsByteArrayAsync(ct);
            var sequence = long.Parse(
                Header(request, ControlPlaneClient.SequenceHeader) ?? "0", CultureInfo.InvariantCulture);

            lock (_gate)
            {
                _frames.Add(new PostedFrame(
                    sequence, Header(request, ControlPlaneClient.SizeHeader), bytes.Length, Header(request, ControlPlaneClient.OriginHeader)));

                if (sequence > _highestSequence) _highestSequence = sequence;
                else _discardedFrames++;
            }

            return Empty(HttpStatusCode.NoContent);
        }

        if (path.EndsWith("/live/input", StringComparison.Ordinal))
        {
            if (Stalling(ref _stallInputPolls)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            LiveInputBatch? batch;
            lock (_gate)
            {
                batch = _pendingInput.Count == 0 ? null : _pendingInput.Dequeue();
                _inputPolls++;
            }

            if (batch is not null) return Json(System.Text.Json.JsonSerializer.Serialize(batch, AgentJson.Options));

            await Task.Delay(PollWindow, ct);
            return Empty(HttpStatusCode.NoContent);
        }

        if (path.EndsWith("/renew", StringComparison.Ordinal))
        {
            if (Stalling(ref _stallRenewals)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            lock (_gate) _renewedAt.Add(Time.GetUtcNow());
            return Empty(RenewRefused ? HttpStatusCode.Conflict : HttpStatusCode.NoContent);
        }

        if (path.EndsWith("/progress", StringComparison.Ordinal))
        {
            var posted = await ReadAsync<ProgressReport>(request, ct);
            lock (_gate) _progress.Add(posted);
            return Empty(HttpStatusCode.NoContent);
        }

        if (path.EndsWith("/challenge", StringComparison.Ordinal))
        {
            var raised = await ReadAsync<RaiseChallengeRequest>(request, ct);
            lock (_gate)
            {
                _challengesRaised++;
                _raised = raised;
            }

            return Json("""{"challenge_id":"chl_test"}""");
        }

        if (path.EndsWith("/answer", StringComparison.Ordinal))
        {
            if (Stalling(ref _answerBlips)) return Empty(HttpStatusCode.ServiceUnavailable);

            ChallengeAnswer? answer;
            lock (_gate) answer = _answer;

            return answer is null
                ? Empty(HttpStatusCode.NoContent)
                : Json($$"""{"challenge_id":"{{answer.ChallengeId}}","value":"{{answer.Value}}"}""");
        }

        if (path.EndsWith("/trace", StringComparison.Ordinal))
        {
            var raw = await request.Content!.ReadAsByteArrayAsync(ct);
            if (request.Content.Headers.ContentEncoding.Contains("gzip"))
            {
                using var zipped = new MemoryStream(raw);
                using var unzip = new System.IO.Compression.GZipStream(zipped, System.IO.Compression.CompressionMode.Decompress);
                using var plain = new MemoryStream();
                await unzip.CopyToAsync(plain, ct);
                raw = plain.ToArray();
            }

            var trace = System.Text.Json.JsonSerializer.Deserialize<Connector.Kit.Tracing.JobTrace>(raw, AgentJson.Options)!;
            lock (_gate) _traces.Add(trace);
            return Empty(HttpStatusCode.OK);
        }

        if (path.EndsWith("/result", StringComparison.Ordinal))
        {
            var result = await ReadAsync<JobResultRequest>(request, ct);
            lock (_gate) _results.Add(result);
            return Empty(ResultStatus);
        }

        if (path.EndsWith("/fail", StringComparison.Ordinal))
        {
            var failure = await ReadAsync<JobFailRequest>(request, ct);
            lock (_gate) _failures.Add(failure);

            if (FailStatus != HttpStatusCode.OK) return Empty(FailStatus);

            // answers with the recorded state: a failure post does not always end a job (a retriable code is requeued)
            // and the agent's sign-out is gated on it
            return Json(System.Text.Json.JsonSerializer.Serialize(
                new AgentFailResponse { State = FailState }, AgentJson.Options));
        }

        return Empty(HttpStatusCode.NotFound);
    }

    public bool FailedWith(ErrorCode code) =>
        string.Equals(FailureCode, ErrorCatalog.Wire(code), StringComparison.Ordinal);

    // a stalled request is answered by nobody: the caller's own client timeout ends it
    private bool Stalling(ref int remaining)
    {
        lock (_gate)
        {
            if (remaining <= 0) return false;

            remaining--;
            return true;
        }
    }

    private static string? Header(HttpRequestMessage request, string name) =>
        request.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;

    private static async Task<T> ReadAsync<T>(HttpRequestMessage request, CancellationToken ct)
    {
        var body = await request.Content!.ReadAsStringAsync(ct);
        return System.Text.Json.JsonSerializer.Deserialize<T>(body, AgentJson.Options)!;
    }

    // HttpClient's timeout enforced above the handler but on Time, so a test need not sit through seventy real seconds.
    // raises TaskCanceledException with nobody's token cancelled, the shape ControlPlaneClient's translation exists for
    private sealed class Bounded(FakeControlPlane control, TimeSpan timeout, TimeProvider time)
        : DelegatingHandler(control)
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            using var abandon = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // armed right after the stamp it is measured against: the test's clock is on another thread and moves between statements
            var sentAt = time.GetUtcNow();
            var lapsed = Task.Delay(timeout, time, abandon.Token);

            var sending = base.SendAsync(request, abandon.Token);
            var first = await Task.WhenAny(sending, lapsed).ConfigureAwait(false);

            await abandon.CancelAsync().ConfigureAwait(false);

            if (first == sending) return await sending.ConfigureAwait(false);

            // the caller walking away is its own cancellation: no bound bit, nothing was given up on
            ct.ThrowIfCancellationRequested();

            var path = request.RequestUri!.AbsolutePath;
            control.GaveUpOn(path, timeout, time.GetUtcNow() - sentAt);

            throw new TaskCanceledException(
                $"the client gave up on {path} after {timeout}", new TimeoutException());
        }
    }

    private static HttpResponseMessage Empty(HttpStatusCode status) => new(status);

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}
