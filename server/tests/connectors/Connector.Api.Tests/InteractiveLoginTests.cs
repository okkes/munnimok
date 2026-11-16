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

// api-spec §2.2 and §8 steps 2-3: a login that stops to ask a human
[Collection(ShopApiCollection.Name)]
public sealed class InteractiveLoginTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Captcha;
    private const string CorrectAnswer = "MOCK1";

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
        // wrapped so an intermittent failure carries its run with it: two flakes left no message (see Postmortem)
        string? sessionId = null;

        await Postmortem.WatchAsync(factory, () => sessionId, async () =>
        {
            using var http = factory.CreateAuthorizedClient();
            var subject = Flows.NewSubject("captcha");

            http.ActAs(subject);
            http.ActAs(subject);
        using var request = Wire.Post($"/v1/{Provider}/login", new { Subject = subject, Inputs = Credentials });
            using var login = await http.SendAsync(request);
            var accepted = await login.JsonAsync();

            Assert.Equal(HttpStatusCode.Accepted, login.StatusCode);

            Assert.NotEmpty(Assert.Single(login.RawHeader(RequestContext.ManifestVersionHeader)));

            sessionId = accepted.Text("session_id");

            // settled by polling: /login waits only Timeouts.LoginWaitSeconds, so a busy machine can answer a correct
            // `running` with no challenge yet
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

            // mandatory: a challenge holds a live run hostage, so a consumer must know when it stops being answerable
            Assert.True(challenge.GetProperty("expires_at").TryGetDateTimeOffset(out var expiresAt));
            Assert.True(expiresAt > DateTimeOffset.UtcNow, "a challenge is raised with a future deadline");

            Assert.Contains(awaiting.GetProperty("progress").Text("step"), LegalSteps);

            // the image is a separate authenticated fetch; it never rides the JSON
            var imageUrl = challenge.Text("image_url");
            Assert.Equal($"/v1/{Provider}/login/{sessionId}/challenges/{challengeId}/image", imageUrl);

            using (var image = await http.GetAsync(imageUrl))
            {
                Assert.Equal(HttpStatusCode.OK, image.StatusCode);
                Assert.Equal("image/png", image.ContentType()?.MediaType);

                var bytes = await image.Content.ReadAsByteArrayAsync();
                Assert.Equal(PngSignature, bytes.Take(PngSignature.Length).ToArray());
            }

            // an answer naming a challenge this run never raised is refused outright
            using (var stray = await AnswerAsync(http, sessionId, "chl_0123456789abcdef0123456789abcdef", CorrectAnswer))
            {
                await ErrorEnvelope.AssertAsync(stray, HttpStatusCode.BadRequest, "unsupported_resource");
            }

            using (var answer = await AnswerAsync(http, sessionId, challengeId, CorrectAnswer))
            {
                Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
                Assert.Equal(sessionId, (await answer.JsonAsync()).Text("session_id"));
            }

            var bundle = await Flows.AwaitBundleAsync(http, Provider, sessionId);
            Assert.StartsWith("sb_v1.", bundle, StringComparison.Ordinal);

            var settled = await Flows.AwaitStateAsync(http, Provider, sessionId, "active");
            Assert.Equal("Mock Store (captcha)", settled.GetProperty("provider_account").Text("display_name"));

            // the bundle is handed over once: a kept copy would be a credential at rest
            Assert.Null(settled.TextOrNull("bundle"));

            // a second answer for the same challenge conflicts: the run already acted on the first
            using (var replay = await AnswerAsync(http, sessionId, challengeId, CorrectAnswer))
            {
                await ErrorEnvelope.AssertAsync(replay, HttpStatusCode.Conflict);
            }

            using (var image = await http.GetAsync(imageUrl))
            {
                await ErrorEnvelope.AssertAsync(image, HttpStatusCode.Gone, "challenge_expired");
            }

            // the answer is cleared too: it can be an SMS code or an OAuth callback URL carrying a live authorization
            // code (Lidl Plus declares it Secret); it outlived the inputs and the picture until the row was deleted
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

        http.ActAs(subject);
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

    // the endpoint once marked the session running after enqueueing, so a fast job's awaiting_input was put back;
    // the transition is now a no-op on a session that has moved on, in whichever order the two writes land
    [Fact]
    public async Task A_session_waiting_on_a_challenge_is_not_marked_running_again()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("captcha-race");

        http.ActAs(subject);
        using var request = Wire.Post($"/v1/{Provider}/login", new { Subject = subject, Inputs = Credentials });
        using var login = await http.SendAsync(request);

        var sessionId = (await login.JsonAsync()).Text("session_id");

        await Flows.AwaitStateAsync(http, Provider, sessionId, "awaiting_input");

        using var scope = factory.Services.CreateScope();

        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var sessions = scope.ServiceProvider.GetRequiredService<SessionService>();

        var row = await db.Sessions.FirstAsync(s => s.Id == sessionId, CancellationToken.None);

        Assert.Equal(SessionState.AwaitingInput, row.State);

        await sessions.StartAsync(row, CancellationToken.None);

        Assert.Equal(SessionState.AwaitingInput, row.State);

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
