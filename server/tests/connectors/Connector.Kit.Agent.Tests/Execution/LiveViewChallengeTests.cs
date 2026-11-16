using Connector.Kit.Agent.Execution;
using Connector.Kit.Challenges;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Tests;

// AskAsync opens and closes the stream around the challenge, so an adapter author cannot forget to stop it
public class LiveViewChallengeTests
{
    // "a live view frame is never stored" is what makes the custody claim true; asserted with an adapter that offers an image
    [Fact]
    public async Task A_live_view_never_carries_a_stored_image()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        rig.Control.Answer(string.Empty);

        await context.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                PromptKey = "connect.challenge.live_login",
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(30),
                Image = [1, 2, 3, 4],
                Crop = new CropRegion(0, 0, 390, 844),
            },
            CancellationToken.None);

        Assert.Null(rig.Control.Raised!.ImageBase64);
    }

    // control: an image challenge still carries its bytes, so the refusal above reads as live-view only
    [Fact]
    public async Task An_image_challenge_still_carries_its_picture()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        rig.Control.Answer("solved");

        await context.AskAsync(
            new Challenge
            {
                Type = ChallengeType.Image,
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(30),
                Image = [1, 2, 3, 4],
            },
            CancellationToken.None);

        Assert.Equal(Convert.ToBase64String([1, 2, 3, 4]), rig.Control.Raised!.ImageBase64);
    }

    // the stream is an optimisation on a passive challenge: failing to open one must degrade to waiting, not fail the job
    [Fact]
    public async Task A_live_view_with_no_browser_waits_instead_of_failing()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        rig.Control.Answer(string.Empty);

        var answer = await context.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(30),
            },
            CancellationToken.None);

        Assert.Equal("chl_test", answer.ChallengeId);
        Assert.Empty(rig.Control.Frames);
    }

    // the frame sequence is monotonic per job and the connector drops frames not above its slot's while answering 200;
    // a counter restarted per live view left the human on a stale page. Needs a real browser: a posted picture
    [Fact]
    public async Task Two_live_views_in_one_job_share_one_frame_count()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60));

        // a real navigation: the stream pins to the origin the page is on when it opens, and about:blank has none
        var page = await context.Browser.PageAsync(CancellationToken.None);
        await page.RouteAsync("**/*", route => route.FulfillAsync(new RouteFulfillOptions
        {
            ContentType = "text/html",
            Body = LiveFrameTests.LoginForm(),
        }));

        await page.GotoAsync("https://provider.test/login");

        await OneLiveViewAsync(rig, context);
        var afterFirst = rig.Control.Frames.Count;
        await OneLiveViewAsync(rig, context);

        Assert.True(rig.Control.Frames.Count > afterFirst, "the second live view posted nothing at all");

        Assert.Equal(0, rig.Control.DiscardedFrames);
    }

    // the manifest declares two hosts, the context hands them to the stream, which follows the hop (DUO to DigiD froze it)
    [Fact]
    public async Task A_login_that_crosses_to_an_identity_provider_keeps_streaming()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());

        var federated = TestRig.Manifest with
        {
            Auth = TestRig.Manifest.Auth with { LoginOrigins = ["provider.test", "idp.test"] },
        };

        await using var context = rig.Context(TestRig.Login(budgetSeconds: 60), federated);

        var page = await context.Browser.PageAsync(CancellationToken.None);
        await page.RouteAsync("**/*", route => route.FulfillAsync(new RouteFulfillOptions
        {
            ContentType = "text/html",
            Body = LiveFrameTests.LoginForm(),
        }));

        await page.GotoAsync("https://provider.test/login");

        var already = rig.Control.Frames.Count;
        rig.Control.SaysNothingYet();

        var asked = Task.Run(() => context.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                PromptKey = "connect.challenge.live_login",
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(60),
            },
            CancellationToken.None));

        await UntilAsync(() => rig.Control.Frames.Count > already, "the first frame");

        // undeclared, the stream latches shut at this hop for good
        var beforeHop = rig.Control.Frames.Count;
        await page.GotoAsync("https://idp.test/authenticate");

        await UntilAsync(
            () => rig.Control.Frames.Count > beforeHop,
            "frames to keep arriving after the hop to the identity provider");

        rig.Control.Answer(string.Empty);
        await asked;
    }

    private static async Task UntilAsync(Func<bool> done, string what)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);

        while (!done())
        {
            Assert.True(DateTimeOffset.UtcNow < deadline, $"timed out waiting for {what}");
            await Task.Delay(25);
        }
    }

    private static async Task OneLiveViewAsync(TestRig rig, AgentJobContext context)
    {
        var already = rig.Control.Frames.Count;
        rig.Control.SaysNothingYet();

        var asked = Task.Run(() => context.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                PromptKey = "connect.challenge.live_login",
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(60),
            },
            CancellationToken.None));

        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
        while (rig.Control.Frames.Count <= already)
        {
            Assert.True(DateTimeOffset.UtcNow < deadline, "timed out waiting for a live frame");
            await Task.Delay(25);
        }

        rig.Control.Answer(string.Empty);
        await asked;
    }
}
