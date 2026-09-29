using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using System.Net;
using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// api-spec §2.2 and §8 steps 2-3: a login that stops to ask a human, and
/// everything that follows from it.
///
/// This is the case the platform exists for. A connector that can only serve
/// providers which never ask a question cannot serve the providers people
/// actually use.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class InteractiveLoginTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Captcha;
    private const string CorrectAnswer = "MOCK1";

    /// <summary>PNG's magic number. Bytes that survive the relay are bytes a consumer can render.</summary>
    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>The closed progress vocabulary of api-spec §2.2. Typed, never prose.</summary>
    private static readonly HashSet<string> LegalSteps =
        [.. Enum.GetNames<JobStep>().Select(SnakeCase)];

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task A_captcha_login_relays_the_challenge_answers_it_and_ends_with_a_bundle()
    
    {
        // Wrapped so that an intermittent failure carries the run with
        // it. This test failed twice on 2026-08-12 and neither message
        // was ever seen; see Postmortem for why that is the problem
        // rather than the flake itself.
        string? sessionId = null;

        await Postmortem.WatchAsync(factory, () => sessionId, async () =>
        {
            using var http = factory.CreateAuthorizedClient();
            var subject = Flows.NewSubject("captcha");

            // 1. The run stopped to ask something, and says so with a 202 rather
            //    than holding a socket open for as long as a human takes.
            using var request = Wire.Post($"/v1/{Provider}/login", new { Subject = subject, Inputs = Credentials });
            using var login = await http.SendAsync(request);
            var accepted = await login.JsonAsync();

            Assert.Equal(HttpStatusCode.Accepted, login.StatusCode);

            // Every response that touched a provider says which contract answered.
            Assert.NotEmpty(Assert.Single(login.RawHeader(RequestContext.ManifestVersionHeader)));

            sessionId = accepted.Text("session_id");

            // SETTLED BY POLLING, not by hoping the endpoint won the race.
            //
            // /login answers as soon as the session reaches something worth
            // reporting, but it only waits Timeouts.LoginWaitSeconds for that - a
            // bounded window, deliberately, because holding a socket open for a
            // two-minute bank login helps nobody. A machine busy with something
            // else can miss it, and then this response is a perfectly correct
            // `running` with no challenge on it yet, and every assertion below
            // fails on a run where nothing is wrong.
            //
            // That is the shape of the intermittent failure seen on 2026-08-12,
            // twice, on a machine that was building containers at the time. It was
            // never reproduced afterwards in twelve consecutive runs, so this is a
            // race removed on the evidence of the code rather than a diagnosis
            // proven from a captured failure - but the claim being made here was
            // never about the scheduler. It is that a captcha login relays its
            // challenge, gets an answer, and ends with a bundle.
            var awaiting = string.Equals(accepted.Text("state"), "awaiting_input", StringComparison.Ordinal)
                ? accepted
                : await Flows.AwaitStateAsync(http, Provider, sessionId, "awaiting_input");

            Assert.Equal("awaiting_input", awaiting.Text("state"));

            var challenge = awaiting.GetProperty("challenge");
            var challengeId = challenge.Text("id");

            Assert.StartsWith("ses_", sessionId, StringComparison.Ordinal);
            Assert.StartsWith("chl_", challengeId, StringComparison.Ordinal);
            Assert.Equal("image", challenge.Text("type"));
            Assert.Equal("connect.challenge.captcha", challenge.Text("prompt_key"));

            // Mandatory: a challenge holds a live run hostage, so a consumer has to
            // know when the question stops being answerable.
            Assert.True(challenge.GetProperty("expires_at").TryGetDateTimeOffset(out var expiresAt));
            Assert.True(expiresAt > DateTimeOffset.UtcNow, "a challenge is raised with a future deadline");

            // Progress is a member of a closed enum, so it can be translated and
            // rendered instead of string-matched.
            Assert.Contains(awaiting.GetProperty("progress").Text("step"), LegalSteps);

            // 2. The image is a separate authenticated fetch; it never rides the JSON.
            var imageUrl = challenge.Text("image_url");
            Assert.Equal($"/v1/{Provider}/login/{sessionId}/challenges/{challengeId}/image", imageUrl);

            using (var image = await http.GetAsync(imageUrl))
            {
                Assert.Equal(HttpStatusCode.OK, image.StatusCode);
                Assert.Equal("image/png", image.ContentType()?.MediaType);

                var bytes = await image.Content.ReadAsByteArrayAsync();
                Assert.Equal(PngSignature, bytes.Take(PngSignature.Length).ToArray());
            }

            // 3. An answer naming a challenge this run never raised is refused
            //    outright, rather than being handed to a waiting adapter.
            using (var stray = await AnswerAsync(http, sessionId, "chl_0123456789abcdef0123456789abcdef", CorrectAnswer))
            {
                await ErrorEnvelope.AssertAsync(stray, HttpStatusCode.BadRequest, "unsupported_resource");
            }

            // 4. The human answers, and the run continues from where it stopped.
            using (var answer = await AnswerAsync(http, sessionId, challengeId, CorrectAnswer))
            {
                Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
                Assert.Equal(sessionId, (await answer.JsonAsync()).Text("session_id"));
            }

            var bundle = await Flows.AwaitBundleAsync(http, Provider, sessionId);
            Assert.StartsWith("sb_v1.", bundle, StringComparison.Ordinal);

            var settled = await Flows.AwaitStateAsync(http, Provider, sessionId, "active");
            Assert.Equal("Mock Store (captcha)", settled.GetProperty("provider_account").Text("display_name"));

            // The bundle is handed over exactly once: a copy kept here would be a
            // credential at rest with no reason to exist.
            Assert.Null(settled.TextOrNull("bundle"));

            // 5. A second answer for the same challenge conflicts rather than
            //    confusing a run that already acted on the first.
            using (var replay = await AnswerAsync(http, sessionId, challengeId, CorrectAnswer))
            {
                await ErrorEnvelope.AssertAsync(replay, HttpStatusCode.Conflict);
            }

            // 6. The picture served its purpose the instant it was answered.
            using (var image = await http.GetAsync(imageUrl))
            {
                await ErrorEnvelope.AssertAsync(image, HttpStatusCode.Gone, "challenge_expired");
            }

            // 7. And so did the answer, which was being kept like a diagnostic
            //    and is nothing of the kind. Here it is a captcha solution, but
            //    the same column carries an SMS code, and it carries the callback
            //    URL of an OAuth redirect - which Lidl Plus declares Secret in as
            //    many words, "the pasted address carries a live authorization
            //    code... it buys the same access". The login inputs are gone at
            //    terminal state and the picture goes on answer; this outlived
            //    both, sitting in the table until the row was deleted a day after
            //    expiry.
            var answers = Db.Read(factory, db => db.Challenges
                .Where(c => c.Id == challengeId)
                .Select(c => c.AnswerValue)
                .ToList());

            Assert.Single(answers);
            Assert.Null(answers[0]);
    
        });
    }

    [Fact]
    public async Task A_wrong_answer_fails_the_login_and_is_never_retried()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("captcha-wrong");

        using var request = Wire.Post($"/v1/{Provider}/login", new { Subject = subject, Inputs = Credentials });
        using var login = await http.SendAsync(request);
        var accepted = await login.JsonAsync();

        Assert.Equal(HttpStatusCode.Accepted, login.StatusCode);
        var sessionId = accepted.Text("session_id");

        using (var answer = await AnswerAsync(http, sessionId, accepted.GetProperty("challenge").Text("id"), "not-it"))
        {
            Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        }

        await Flows.AwaitStateAsync(http, Provider, sessionId, "failed");

        // No wire surface says this, and it is the rule that matters most: a
        // credential that has already gone upstream is never submitted again.
        var job = Db.LatestJob(factory, sessionId);
        Assert.Equal(ErrorCode.MfaFailed, job.ErrorCode);
        Assert.Equal(1, job.Attempts);
        Assert.True(job.CredentialSubmitted, "the adapter latched the credential before the provider saw it");
        Assert.Null(job.InputsJson);
    }

    /// <summary>
    /// A SESSION PARKED ON A QUESTION IS NOT PUT BACK TO RUNNING.
    /// </summary>
    /// <remarks>
    /// The login endpoint enqueued the job and marked the session running
    /// afterwards, so a job that started immediately could raise its challenge
    /// - moving the session to <c>awaiting_input</c> - before that write
    /// landed. <c>awaiting_input</c> to <c>running</c> is a legal edge, so the
    /// endpoint's write went through and put the session back.
    /// <para>
    /// What that leaves is a session reporting <c>running</c> while holding an
    /// unanswered challenge and a progress step reading <c>awaiting_human</c>:
    /// a consumer polling for state never learns it has to ask anybody
    /// anything, and the login sits there until it expires. This is not
    /// hypothetical - it is what an intermittent failure of the test above
    /// finally printed when it was reproduced under load, after sixteen clean
    /// runs said nothing was wrong.
    /// </para>
    /// <para>
    /// The endpoint marks the session running before the job exists now, so the
    /// race cannot occur. This asserts the guard that keeps it gone: the
    /// transition is a no-op on a session that has already moved on, whichever
    /// order those two lines end up in.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_session_waiting_on_a_challenge_is_not_marked_running_again()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("captcha-race");

        using var request = Wire.Post($"/v1/{Provider}/login", new { Subject = subject, Inputs = Credentials });
        using var login = await http.SendAsync(request);

        var sessionId = (await login.JsonAsync()).Text("session_id");

        // Genuinely parked on the question, rather than merely started.
        await Flows.AwaitStateAsync(http, Provider, sessionId, "awaiting_input");

        using var scope = factory.Services.CreateScope();

        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var sessions = scope.ServiceProvider.GetRequiredService<SessionService>();

        var row = await db.Sessions.FirstAsync(s => s.Id == sessionId, CancellationToken.None);

        Assert.Equal(SessionState.AwaitingInput, row.State);

        // The endpoint's own call, arriving late. It must do nothing.
        await sessions.StartAsync(row, CancellationToken.None);

        Assert.Equal(SessionState.AwaitingInput, row.State);

        // And the consumer still sees a session that needs answering, which is
        // the only thing any of this is for.
        var seen = await Flows.ReadSessionAsync(http, Provider, sessionId);
        Assert.Equal("awaiting_input", seen.Text("state"));
    }

    private static async Task<HttpResponseMessage> AnswerAsync(
        HttpClient http, string sessionId, string challengeId, string value)
    {
        using var request = Wire.Post($"/v1/{Provider}/login/{sessionId}/answer",
            new { ChallengeId = challengeId, Value = value });

        return await http.SendAsync(request);
    }

    private static string SnakeCase(string name)
    {
        var builder = new StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            if (char.IsUpper(name[i]) && i > 0) builder.Append('_');
            builder.Append(char.ToLowerInvariant(name[i]));
        }

        return builder.ToString();
    }
}
