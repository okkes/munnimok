using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Security;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// The job context as the adapter sees it: the leased job's inputs and
/// material, the credential flag, and what asking a human looks like when
/// the answer is taps, is text, is for somebody else, or never comes.
/// </summary>
public sealed class JobContextTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private static Challenge Taps(DateTimeOffset expiresAt) => new()
    {
        Type = ChallengeType.Image,
        AnswerKind = ChallengeAnswerKind.Taps,
        ExpiresAt = expiresAt,
        Crop = new CropRegion(10, 20, 200, 100),
        Image = [1, 2, 3],
    };

    [Fact]
    public async Task The_context_hands_the_adapter_the_job_as_it_was_leased()
    {
        using var rig = new TestRig(new DecidedAdapter());
        var job = TestRig.Login(budgetSeconds: 60) with
        {
            Config = new Dictionary<string, string>(StringComparer.Ordinal) { ["region"] = "nl" },
            Material = new SessionMaterial { DeviceId = "dev_1" },
        };

        await using var context = rig.Context(job);

        Assert.Equal(job.SessionId, context.SessionId);
        Assert.Equal(job.JobId, context.JobId);
        Assert.Equal("hunter2", context.Inputs["password"]);
        Assert.Equal("nl", context.Config["region"]);
        Assert.Equal("dev_1", context.Material?.DeviceId);
        Assert.NotNull(context.Http);
        Assert.NotNull(context.Pacer);
        Assert.Contains("hunter2", context.SecretValues);
        Assert.False(context.HasSubmittedCredential);
    }

    [Fact]
    public async Task Submitting_a_credential_is_remembered_once()
    {
        using var rig = new TestRig(new DecidedAdapter());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));

        context.CredentialSubmitted();
        context.CredentialSubmitted();

        Assert.True(context.HasSubmittedCredential);
    }

    [Fact]
    public async Task A_challenge_that_expired_before_it_was_raised_is_refused_without_a_round_trip()
    {
        using var rig = new TestRig(new DecidedAdapter());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));

        var refused = await Assert.ThrowsAsync<ConnectorException>(() =>
            context.AskAsync(Taps(DateTimeOffset.UtcNow.AddMinutes(-1)), CancellationToken.None));

        Assert.Equal(ErrorCode.ChallengeExpired, refused.Code);
        Assert.Equal(0, rig.Control.ChallengesRaised);
    }

    [Fact]
    public async Task A_taps_challenge_goes_up_with_its_image_and_comes_back_with_the_taps()
    {
        using var rig = new TestRig(new DecidedAdapter());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));
        var taps = new TapAnswer { Taps = [new Tap(0.5, 0.25)], Submit = true }.Format();
        rig.Control.Answer(taps);

        var answer = await context.AskAsync(Taps(DateTimeOffset.UtcNow.AddSeconds(30)), CancellationToken.None).WaitAsync(Patience);

        Assert.Equal(taps, answer.Value);
        Assert.Equal(ChallengeAnswerKind.Taps, rig.Control.Raised?.AnswerKind);
        Assert.Equal(Convert.ToBase64String([1, 2, 3]), rig.Control.Raised?.ImageBase64);
    }

    [Fact]
    public async Task A_taps_challenge_answered_with_text_is_still_handed_to_the_adapter()
    {
        using var rig = new TestRig(new DecidedAdapter());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));
        rig.Control.Answer("not taps at all");

        var answer = await context.AskAsync(Taps(DateTimeOffset.UtcNow.AddSeconds(30)), CancellationToken.None).WaitAsync(Patience);

        Assert.Equal("not taps at all", answer.Value);
    }

    [Fact]
    public async Task An_answer_for_some_other_challenge_is_ignored_until_the_deadline()
    {
        using var rig = new TestRig(new DecidedAdapter());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));
        rig.Control.Answer("solved", challengeId: "chl_other");

        var timedOut = await Assert.ThrowsAsync<ConnectorException>(() =>
            context.AskAsync(Taps(DateTimeOffset.UtcNow.AddMilliseconds(400)), CancellationToken.None).WaitAsync(Patience));

        Assert.Equal(ErrorCode.MfaTimeout, timedOut.Code);
    }

    [Fact]
    public async Task A_poll_that_blips_is_retried_rather_than_dropped()
    {
        using var rig = new TestRig(new DecidedAdapter());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));
        rig.Control.AnswerBlips(2);
        rig.Control.Answer("123456");

        var answer = await context.AskAsync(
            new Challenge { Type = ChallengeType.MfaCode, ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(30) },
            CancellationToken.None).WaitAsync(Patience);

        Assert.Equal("123456", answer.Value);
    }

    [Fact]
    public async Task A_work_directory_something_still_holds_is_not_a_crash_on_dispose()
    {
        using var rig = new TestRig(new DecidedAdapter());
        var context = rig.Context(TestRig.Login(budgetSeconds: 60));
        var held = Path.Combine(context.WorkDirectory, "download.pdf");

        await using (var stream = new FileStream(held, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await stream.WriteAsync(new byte[] { 1 });

            var exception = await Record.ExceptionAsync(async () => await context.DisposeAsync());

            Assert.Null(exception);
        }

        if (Directory.Exists(context.WorkDirectory)) Directory.Delete(context.WorkDirectory, recursive: true);
    }
}
