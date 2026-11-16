using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using Microsoft.Playwright;

namespace RegistryConnector.Adapters.Tests;

internal sealed class FakeJobContext : IJobContext, IDisposable
{
    private readonly List<Challenge> _asked = [];
    private readonly List<string> _notes = [];
    private readonly List<JobStep> _steps = [];
    private readonly List<int> _counted = [];

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

    // the lease serves only the cookie jar a completed sign-in leaves; browser behaviour is exercised through the page seam
    public IBrowserLease Browser { get; init; } = new StubBrowserLease();

    public string WorkDirectory { get; } = Path.GetTempPath();

    public bool Attended { get; init; } = true;

    // false, as the contract's default: a first connect has no session, so SessionProbe must not look for one.
    // a test of an already-signed-in browser sets it
    public bool KeepsSession { get; init; }

    public IReadOnlyList<Challenge> Asked => _asked;

    /// <summary>What the human types back. Null answers nothing.</summary>
    public Func<Challenge, string?>? Answer { get; init; }

    // never answers, like a streamed sign-in: the session appearing, not an answer, ends the challenge
    public bool AnswersNothing { get; init; }

    public IReadOnlyList<JobStep> Steps => _steps;

    // recorded because on DUO notes tell apart a fetch that lost its interest rate from a provider that states none
    public IReadOnlyList<string> Notes => _notes;

    public bool CredentialWasSubmitted { get; private set; }

    public void Progress(JobStep step) => _steps.Add(step);

    public IReadOnlyList<int> Counted => _counted;

    public void Found(int records) => _counted.Add(records);

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
