using System.Globalization;
using System.Net;
using System.Text;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// The control plane as eleven routes over a stubbed handler.
///
/// Deliberately not a mock of <see cref="ControlPlaneClient"/>: that class is
/// sealed and concrete on purpose, and stubbing at the socket keeps its own
/// status-code rules - a 4xx renew is a verdict, a 5xx is a bad moment - in
/// the path under test.
/// </summary>
internal sealed class FakeControlPlane : HttpMessageHandler, IHttpClientFactory
{
    /// <summary>
    /// How long an empty long poll - for live input, or for work - waits before
    /// answering 204.
    ///
    /// A real one holds the request for tens of seconds. Nought here would spin
    /// the polling loop at the speed of the CPU and drown the very timings
    /// these tests exist to measure; a short window keeps the SHAPE of a long
    /// poll without the wait.
    /// </summary>
    private static readonly TimeSpan PollWindow = TimeSpan.FromMilliseconds(50);

    /// <summary>
    /// The bounds the production registration puts on the two clients, read
    /// from the options themselves rather than restated.
    /// </summary>
    /// <remarks>
    /// A fake that carried numbers of its own would answer questions about
    /// itself: the whole point of these cases is what happens under the values
    /// an agent really ships with, so a default changed in
    /// <see cref="ConnectorAgentOptions"/> has to move the tests with it.
    /// </remarks>
    private static readonly ConnectorAgentOptions Shipped = new();

    private readonly Lock _gate = new();
    private readonly List<EnrollRequest> _enrollments = [];
    private readonly List<JobFailRequest> _failures = [];
    private readonly List<DateTimeOffset> _renewedAt = [];
    private readonly List<DateTimeOffset> _beatsAt = [];
    private readonly List<Abandoned> _abandoned = [];

    /// <summary>Jobs this control plane will hand out, one per lease call.</summary>
    private readonly Queue<LeasedJob> _queued = new();

    /// <summary>Puts work in front of an agent, for a host that goes and gets it.</summary>
    public void Enqueue(params LeasedJob[] jobs)
    {
        ArgumentNullException.ThrowIfNull(jobs);
        lock (_gate) foreach (var job in jobs) _queued.Enqueue(job);
    }

    /// <summary>
    /// What this control plane records for a reported failure.
    /// </summary>
    /// <remarks>
    /// <see cref="JobState.Queued"/> is the retriable case - the job is not
    /// over, and an agent that tidied up now would hand the next attempt a dead
    /// session.
    /// </remarks>
    public JobState FailState { get; set; } = JobState.Failed;
    private readonly List<JobResultRequest> _results = [];
    private readonly List<PostedFrame> _frames = [];
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

    /// <summary>One live frame as it arrived on the wire.</summary>
    internal readonly record struct PostedFrame(long Sequence, string? Size, int Bytes);

    /// <summary>
    /// A request nobody answered, the bound of the client that sent it, and how
    /// long that client really held on before giving up.
    /// </summary>
    /// <remarks>
    /// <see cref="Bound"/> is the decision - which of the two clients this call
    /// went out on, which is the whole of the fix - and <see cref="Held"/> is
    /// what it cost in agent time. They agree to within a step of the clock:
    /// the bound is armed when the request leaves, and the test's clock may
    /// have moved a step between the two.
    /// </remarks>
    internal readonly record struct Abandoned(string Path, TimeSpan Bound, TimeSpan Held);

    /// <summary>Answers the pending challenge, as a human eventually would.</summary>
    public void Answer(string value = "solved", string challengeId = "chl_test")
    {
        lock (_gate) _answer = new ChallengeAnswer { ChallengeId = challengeId, Value = value };
    }

    /// <summary>
    /// Takes the answer away again, so a second challenge on the same job waits
    /// for its own.
    /// </summary>
    public void SaysNothingYet()
    {
        lock (_gate) _answer = null;
    }

    /// <summary>Makes the next <paramref name="count"/> answer polls fail with a 503, as a home line blips.</summary>
    public void AnswerBlips(int count)
    {
        lock (_gate) _answerBlips = count;
    }

    /// <summary>What a posted result is answered with; a 4xx is a verdict, a 5xx an outage.</summary>
    public HttpStatusCode ResultStatus { get; set; } = HttpStatusCode.NoContent;

    /// <summary>What a posted failure is answered with when it is not the recorded state.</summary>
    public HttpStatusCode FailStatus { get; set; } = HttpStatusCode.OK;

    /// <summary>True makes every renew answer 409: the control plane no longer holds the lease for this agent.</summary>
    public bool RenewRefused { get; set; }

    public int ResultCount { get { lock (_gate) return _results.Count; } }

    /// <summary>
    /// How long this agent's HTTP client waits before giving up on a request.
    ///
    /// Short in the tests that want it, because the failure it produces - a
    /// <c>TaskCanceledException</c>, which IS an
    /// <c>OperationCanceledException</c> - is indistinguishable from the caller
    /// stopping the stream unless somebody checks whose token fired.
    /// </summary>
    public TimeSpan ClientTimeout { get; set; } = Shipped.ControlPlaneTimeout;

    /// <summary>
    /// And what the KEEPALIVE client waits, which is a different and much
    /// shorter number - the renew and the heartbeat are sent on a client of
    /// their own precisely so they can be abandoned in time to be retried.
    /// </summary>
    public TimeSpan KeepaliveTimeout { get; set; } = Shipped.KeepaliveTimeout;

    /// <summary>
    /// Where this control plane lives, which is also the key its enrollment is
    /// filed under in the agent's state file.
    /// </summary>
    /// <remarks>
    /// Settable so a test can be TWO CONNECTORS. One agent process now serves
    /// several, and almost everything worth asserting about that - that each
    /// enrolls on its own, that a revoke from one leaves the other alone -
    /// needs two control planes that can be told apart.
    /// </remarks>
    public Uri BaseAddress { get; set; } = new("https://control-plane.test/");

    /// <summary>
    /// The agent id this control plane issues. Its own, because two connectors
    /// issue two ids to one machine, and a BYO agent's profile ids are derived
    /// from whichever one it is talking to.
    /// </summary>
    public string AgentId { get; set; } = "agt_" + new string('0', 32);

    /// <summary>
    /// Set to answer every heartbeat with <c>revoked</c>, as a control plane
    /// whose user has taken this agent away does.
    /// </summary>
    public bool Revokes { get; set; }

    /// <summary>
    /// The clock those two bounds are measured on, and the one this control
    /// plane stamps arrivals with.
    /// </summary>
    /// <remarks>
    /// The machine's by default, which is what HttpClient uses. A test that
    /// hands over a <see cref="TestClock"/> gets the same behaviour without the
    /// waiting: a bound of ten production seconds bites after ten virtual ones.
    /// </remarks>
    public TimeProvider Time { get; set; } = TimeProvider.System;

    /// <summary>The next <paramref name="count"/> frame POSTs never answer at all.</summary>
    public void StallFrames(int count)
    {
        lock (_gate) _stallFrames = count;
    }

    /// <summary>The next <paramref name="count"/> input long polls never answer at all.</summary>
    public void StallInputPolls(int count)
    {
        lock (_gate) _stallInputPolls = count;
    }

    /// <summary>The next <paramref name="count"/> renew POSTs never answer at all.</summary>
    public void StallRenewals(int count)
    {
        lock (_gate) _stallRenewals = count;
    }

    /// <summary>
    /// The next <paramref name="count"/> heartbeats never answer at all - the
    /// black hole, which is worse for an agent than a refusal: a refused beat
    /// comes back at once and a swallowed one costs whatever the client is
    /// willing to wait.
    /// </summary>
    public void StallHeartbeats(int count)
    {
        lock (_gate) _stallHeartbeats = count;
    }

    /// <summary>Every live frame this agent posted, in order.</summary>
    public IReadOnlyList<PostedFrame> Frames { get { lock (_gate) return [.. _frames]; } }

    /// <summary>
    /// Frames that arrived numbered no higher than one already held, and were
    /// therefore thrown away.
    ///
    /// This is the connector's own rule, and it is modelled here because the
    /// agent cannot see it: the slot is per JOB, a frame that does not advance
    /// the count is discarded, and the response is 200 either way. An agent
    /// restarting the count for a second live view thus streams into a bin, and
    /// nothing at either end says so.
    /// </summary>
    public int DiscardedFrames { get { lock (_gate) return _discardedFrames; } }

    /// <summary>
    /// Set to refuse the live channel, as a control plane whose challenge has
    /// been answered or whose capability was revoked does.
    /// </summary>
    public bool LiveChannelGone { get; set; }

    /// <summary>Queues what the human did, for the next input poll to pick up.</summary>
    public void SendLiveInput(LiveInputBatch batch)
    {
        lock (_gate) _pendingInput.Enqueue(batch);
    }

    /// <summary>
    /// Renewals this control plane ANSWERED. One it was told to hang on is
    /// not among them - the agent's client gave up on it - and that is what
    /// lets a test tell a renewer that carried on from one that died: after
    /// the stall, nought here means nothing came back for it, ever.
    /// </summary>
    public int Renewals { get { lock (_gate) return _renewedAt.Count; } }

    /// <summary>
    /// When each answered renewal arrived, on <see cref="Time"/>. A renewal
    /// that lands is only half the claim; the other half is whether it landed
    /// while the lease was still this agent's.
    /// </summary>
    public IReadOnlyList<DateTimeOffset> RenewedAt { get { lock (_gate) return [.. _renewedAt]; } }

    /// <summary>
    /// When each answered heartbeat arrived, on <see cref="Time"/>. The GAP
    /// between consecutive entries is what the control plane's liveness rule
    /// actually looks at.
    /// </summary>
    public IReadOnlyList<DateTimeOffset> BeatsAt { get { lock (_gate) return [.. _beatsAt]; } }

    /// <summary>Every request a client gave up on, with how long it held it.</summary>
    public IReadOnlyList<Abandoned> GaveUp { get { lock (_gate) return [.. _abandoned]; } }

    /// <summary>
    /// Every enrollment this control plane was asked for, with the code that
    /// was redeemed - the one thing that proves a connector enrolled with ITS
    /// code rather than with whichever one the process happened to hold.
    /// </summary>
    public IReadOnlyList<EnrollRequest> Enrollments { get { lock (_gate) return [.. _enrollments]; } }

    public int ChallengesRaised { get { lock (_gate) return _challengesRaised; } }

    /// <summary>The last challenge as it arrived on the wire, image and all.</summary>
    public RaiseChallengeRequest? Raised { get { lock (_gate) return _raised; } }

    public JobFailRequest? Failure { get { lock (_gate) return _failures.Count == 0 ? null : _failures[^1]; } }

    public JobResultRequest? Result { get { lock (_gate) return _results.Count == 0 ? null : _results[^1]; } }

    /// <summary>The wire code of the last reported failure, or null on success.</summary>
    public string? FailureCode => Failure?.Code;

    /// <summary>How many terminal failure posts this job made. One, or a bug.</summary>
    public int FailureCount { get { lock (_gate) return _failures.Count; } }

    /// <summary>
    /// A client bounded the way the production registration bounds this name.
    /// </summary>
    /// <remarks>
    /// THE NAME IS THE WHOLE POINT. Two clients are registered onto one control
    /// plane - the long polls' and the keepalives' - and which one a call is
    /// sent on is the decision under test. A fake that gave every client the
    /// same timeout, or that picked one by looking at the path, would pass just
    /// as well with the renew sent on the long polls' client, which is the
    /// defect.
    /// </remarks>
    public HttpClient CreateClient(string name) =>
        new(new Bounded(this, Bound(name), Time), disposeHandler: false)
        {
            BaseAddress = BaseAddress,

            // Infinite HERE because Bounded is standing in for this very
            // property; leaving both armed would race a real timer against a
            // virtual one.
            Timeout = Timeout.InfiniteTimeSpan,
        };

    /// <summary>
    /// Which of the two bounds a client name carries.
    /// </summary>
    /// <remarks>
    /// By PREFIX, because a client name now ends in the connector it belongs
    /// to - <c>connector-agent-control-plane-keepalive#registry</c> - so that
    /// one process can hold a pair of clients per connector, each with its own
    /// base address, authority and token. The keepalive name is the long
    /// polls' name with a suffix, so testing for it first is what keeps the
    /// two apart.
    /// </remarks>
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
        // Real HTTP never completes synchronously, and a stub that does hides
        // ordering bugs the production path would hit.
        await Task.Yield();
        ct.ThrowIfCancellationRequested();

        var path = request.RequestUri!.AbsolutePath;

        // ---- the agent's own three, for a host rather than a runner --------
        //
        // A JobRunner is handed a job; an AgentHost goes and gets them, and
        // how many it will hold at once is a claim only the host can be asked
        // about. See AgentExclusivityTests, which asserts the production
        // CONFIG says one and says in as many words that the agent honouring
        // it "wants a harness this suite does not have yet".

        if (path.EndsWith("agent/v1/enroll", StringComparison.Ordinal))
        {
            var enrollment = await ReadAsync<EnrollRequest>(request, ct);
            lock (_gate) _enrollments.Add(enrollment);

            return Json(System.Text.Json.JsonSerializer.Serialize(
                new EnrollResponse
                {
                    AgentId = AgentId,
                    Token = "tok_fake",
                    HeartbeatSeconds = 30,

                },
                AgentJson.Options));
        }

        if (path.EndsWith("agent/v1/heartbeat", StringComparison.Ordinal))
        {
            if (Stalling(ref _stallHeartbeats)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            lock (_gate) _beatsAt.Add(Time.GetUtcNow());

            // The contract's own defaults - a two-minute lease - rather than a
            // number copied beside them, so an agent tested here is tested
            // against the lease a control plane really hands out.
            return Json(System.Text.Json.JsonSerializer.Serialize(
                new HeartbeatResponse { Revoked = Revokes }, AgentJson.Options));
        }

        if (path.EndsWith("agent/v1/jobs/lease", StringComparison.Ordinal))
        {
            LeasedJob? next;
            lock (_gate) next = _queued.Count > 0 ? _queued.Dequeue() : null;

            // 204 is "nothing for you", which is what a real long poll answers
            // when the queue is empty - not an error and not a job.
            if (next is not null) return Json(System.Text.Json.JsonSerializer.Serialize(next, AgentJson.Options));

            // And it answers it AFTER holding the request, as the input poll
            // above already does. A stub that answers an empty queue instantly
            // spins a host's lease loop at the speed of the CPU, which drowns
            // whatever else the test is trying to watch.
            await Task.Delay(PollWindow, Time, ct);
            return Empty(HttpStatusCode.NoContent);
        }

        // The live routes first: "/live/frame" also ends with "frame", and a
        // suffix match that ran in the wrong order would answer one route from
        // another's handler.
        if (path.EndsWith("/live/frame", StringComparison.Ordinal))
        {
            if (LiveChannelGone) return Empty(HttpStatusCode.Gone);
            if (Stalling(ref _stallFrames)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            var bytes = await request.Content!.ReadAsByteArrayAsync(ct);
            var sequence = long.Parse(
                Header(request, ControlPlaneClient.SequenceHeader) ?? "0", CultureInfo.InvariantCulture);

            lock (_gate)
            {
                _frames.Add(new PostedFrame(sequence, Header(request, ControlPlaneClient.SizeHeader), bytes.Length));

                // The connector's one slot per job, modelled: higher or nothing.
                if (sequence > _highestSequence) _highestSequence = sequence;
                else _discardedFrames++;
            }

            return Empty(HttpStatusCode.NoContent);
        }

        if (path.EndsWith("/live/input", StringComparison.Ordinal))
        {
            if (Stalling(ref _stallInputPolls)) await Task.Delay(Timeout.InfiniteTimeSpan, ct);

            LiveInputBatch? batch;
            lock (_gate) batch = _pendingInput.Count == 0 ? null : _pendingInput.Dequeue();

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

        if (path.EndsWith("/progress", StringComparison.Ordinal)) return Empty(HttpStatusCode.NoContent);

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

            // THE STATE THE CONTROL PLANE RECORDED, which this used to answer
            // with no content at all. A failure post does not always end a job:
            // the queue requeues a retriable code, and the agent's courtesy
            // sign-out is gated on the difference. A fake that can only say
            // "Failed" cannot test a runner that signs out unconditionally -
            // the same shape as a page fixture where every click hits.
            return Json(System.Text.Json.JsonSerializer.Serialize(
                new AgentFailResponse { State = FailState }, AgentJson.Options));
        }

        return Empty(HttpStatusCode.NotFound);
    }

    /// <summary>Asserts the last failure carried a given code.</summary>
    public bool FailedWith(ErrorCode code) =>
        string.Equals(FailureCode, ErrorCatalog.Wire(code), StringComparison.Ordinal);

    /// <summary>
    /// Whether this request is one of the ones told to hang, taking it off the
    /// count as it goes. A stalled request is answered by nobody: the caller's
    /// own client timeout is what ends it, which is the whole point.
    /// </summary>
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

    /// <summary>
    /// One client's own timeout, enforced where HttpClient enforces it - above
    /// the handler - but on the rig's clock instead of the machine's.
    /// </summary>
    /// <remarks>
    /// HttpClient measures <c>Timeout</c> with a real timer, so a test that
    /// wanted to watch a production bound bite would have to sit through it:
    /// seventy seconds for a long poll, and a whole lease before that. Measured
    /// here instead, against <see cref="Time"/>, which a test can move.
    /// <para>
    /// What the caller sees is what HttpClient raises when it gives up: a
    /// <c>TaskCanceledException</c> - an <c>OperationCanceledException</c> -
    /// with nobody's token cancelled. That is the exact shape
    /// <see cref="ControlPlaneClient"/>'s translation exists for, and the shape
    /// every one of these defects came from, so the fake must raise it rather
    /// than something tidier.
    /// </para>
    /// </remarks>
    private sealed class Bounded(FakeControlPlane control, TimeSpan timeout, TimeProvider time)
        : DelegatingHandler(control)
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            using var abandon = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // Armed before the request goes out, and immediately after the
            // stamp it will be measured against: the test's clock belongs to
            // another thread and can move between any two statements here.
            var sentAt = time.GetUtcNow();
            var lapsed = Task.Delay(timeout, time, abandon.Token);

            var sending = base.SendAsync(request, abandon.Token);
            var first = await Task.WhenAny(sending, lapsed).ConfigureAwait(false);

            // Whichever lost is abandoned, exactly as HttpClient abandons the
            // request it has stopped waiting for.
            await abandon.CancelAsync().ConfigureAwait(false);

            if (first == sending) return await sending.ConfigureAwait(false);

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
