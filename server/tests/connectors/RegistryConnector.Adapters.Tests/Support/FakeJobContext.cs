using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using Microsoft.Playwright;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// A job, without a platform under it.
///
/// Deliberately minimal: the registry providers are HTTP-and-fixtures, so
/// there is no browser to stub. A test that needs one is a test about a
/// provider this service does not have yet.
/// </summary>
internal sealed class FakeJobContext : IJobContext, IDisposable
{
    private readonly List<Challenge> _asked = [];
    private readonly List<string> _notes = [];
    private readonly List<JobStep> _steps = [];

    public string SessionId { get; init; } = "ses_registry_fixture";

    public string JobId { get; init; } = "job_registry_fixture";

    public IReadOnlyDictionary<string, string> Inputs { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "fixture@example.test",
            ["password"] = "hunter2",
        };

    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public SessionMaterial? Material { get; init; }

    public HttpClient Http { get; } = new();

    /// <summary>
    /// The lease, for the one thing the offline suite needs from it: the
    /// cookie jar a completed sign-in leaves behind. Everything a browser
    /// really does is exercised through the page seam instead.
    /// </summary>
    public IBrowserLease Browser { get; init; } = new StubBrowserLease();

    public string WorkDirectory { get; } = Path.GetTempPath();

    public bool Attended { get; init; } = true;

    /// <summary>
    /// Whether this job's browser opens onto something an earlier run left - a
    /// kept profile, or a cookie jar out of the bundle.
    ///
    /// False by default, exactly as the contract's own default is, and that is
    /// the honest setting for most of this suite: a first connect starts from
    /// nothing, so there is no session to find and <c>SessionProbe</c> must not
    /// go looking for one. A test about a browser that could ALREADY be signed
    /// in has to say so.
    /// </summary>
    public bool KeepsSession { get; init; }

    /// <summary>Every challenge the adapter raised, in order.</summary>
    public IReadOnlyList<Challenge> Asked => _asked;

    /// <summary>What the human types back. Null answers nothing.</summary>
    public Func<Challenge, string?>? Answer { get; init; }

    /// <summary>
    /// Never answers, which is what a streamed sign-in really looks like: the
    /// person who signs in on the page in front of them has no reason to come
    /// back to the consumer's UI, so what ends the challenge is the session
    /// appearing rather than an answer arriving.
    /// </summary>
    public bool AnswersNothing { get; init; }

    public IReadOnlyList<JobStep> Steps => _steps;

    /// <summary>
    /// Every operator note the adapter wrote, in order.
    /// </summary>
    /// <remarks>
    /// Recorded rather than discarded because on DUO these carry the
    /// difference between two results that look identical: a fetch that lost
    /// its interest rate and a fetch whose provider states none both arrive as
    /// a record with a null rate, and only the note says which happened.
    /// </remarks>
    public IReadOnlyList<string> Notes => _notes;

    public bool CredentialWasSubmitted { get; private set; }

    public void Progress(JobStep step) => _steps.Add(step);

    public void Note(string message) => _notes.Add(message);

    public void CredentialSubmitted() => CredentialWasSubmitted = true;

    public Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(challenge);

        _asked.Add(challenge);

        if (AnswersNothing) return new TaskCompletionSource<ChallengeAnswer>().Task.WaitAsync(ct);

        return Task.FromResult(new ChallengeAnswer
        {
            ChallengeId = "chl_fixture",
            Value = Answer?.Invoke(challenge) ?? string.Empty,
        });
    }

    public void Dispose() => Http.Dispose();
}
