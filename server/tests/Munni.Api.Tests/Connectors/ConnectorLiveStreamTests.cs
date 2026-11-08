using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit;
using Connector.Kit.Challenges;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The live view pushed (#429): the app holds one stream at this API, this
/// API holds one at the control plane, and every picture the agent posts
/// travels down both without a request of its own. Driven through the real
/// in-process control plane; the run is staged there the way an agent would
/// leave it - a session signing in, a leased job, a live challenge - because
/// no shipped party can be made to raise one on demand.
/// </summary>
public class ConnectorLiveStreamTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    /// <summary>An agent-tier party, so the control plane's own runner leaves the staged job alone.</summary>
    private const string Provider = "ah";

    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46];

    [Fact]
    public async Task The_app_holds_one_stream_and_every_picture_arrives_on_it()
    {
        var run = await ArrangeAsync("live-stream-viewer");
        using var app = factory.ClientFor(run.Sub);
        using var agent = AgentClient(run);

        using var response = await OpenAsync(app, run);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Contains("no", response.Headers.GetValues("X-Accel-Buffering"));

        var events = new EventReader(response);

        await PostFrameAsync(agent, run, 1, Frame(0x01));
        var first = await events.UntilAsync(e => e.Name == "frame", "the first picture");
        AssertFrame(first, 1, Frame(0x01));

        await PostFrameAsync(agent, run, 2, Frame(0x02));
        AssertFrame(await events.UntilAsync(e => e.Name == "frame", "the second picture"), 2, Frame(0x02));
    }

    [Fact]
    public async Task A_reconnect_names_the_picture_it_drew_and_gets_only_a_newer_one()
    {
        var run = await ArrangeAsync("live-stream-reconnect");
        using var app = factory.ClientFor(run.Sub);
        using var agent = AgentClient(run);

        await PostFrameAsync(agent, run, 1, Frame(0x01));
        await PostFrameAsync(agent, run, 2, Frame(0x02));

        using var response = await OpenAsync(app, run, lastEventId: "2");
        var events = new EventReader(response);

        await PostFrameAsync(agent, run, 3, Frame(0x03));
        AssertFrame(await events.UntilAsync(e => e.Name == "frame", "the picture after the one drawn"), 3, Frame(0x03));
    }

    /// <summary>Refused before the first byte with the status the poll answers, so the app can tell "over" from "not yours" from "cannot stream here".</summary>
    [Fact]
    public async Task A_stream_that_cannot_be_held_is_refused_before_it_starts()
    {
        var run = await ArrangeAsync("live-stream-owner");

        using (var stranger = factory.ClientFor("live-stream-stranger"))
        using (var foreign = await OpenAsync(stranger, run))
        {
            Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
            Assert.Equal("unsupported_resource", (await ErrorOf(foreign))["code"]!.GetValue<string>());
        }

        using var app = factory.ClientFor(run.Sub);
        using (var garbled = await OpenAsync(app, run, lastEventId: "not-a-number"))
        {
            Assert.Equal(HttpStatusCode.BadRequest, garbled.StatusCode);
        }

        await ExpireAsync(run);
        using var over = await OpenAsync(app, run);
        Assert.Equal(HttpStatusCode.Gone, over.StatusCode);
        Assert.Equal("challenge_expired", (await ErrorOf(over))["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_end_of_the_live_view_is_the_last_thing_the_stream_says()
    {
        var run = await ArrangeAsync("live-stream-end");
        using var app = factory.ClientFor(run.Sub);
        using var agent = AgentClient(run);

        using var response = await OpenAsync(app, run);
        var events = new EventReader(response);

        await PostFrameAsync(agent, run, 1, Frame(0x01));
        await events.UntilAsync(e => e.Name == "frame", "the picture before the end");
        await SettleAsync(run);

        var end = await events.UntilAsync(e => e.Name == "end", "the end of the live view");
        Assert.Equal("challenge_expired", JsonNode.Parse(end.Data!)!["code"]!.GetValue<string>());
        Assert.Null(await events.NextAsync());
    }

    /// <summary>
    /// A phone that switched networks reconnects while its old connection
    /// still looks open here; the newer stream takes the place, and the older
    /// one is told so and lets its upstream go.
    /// </summary>
    [Fact]
    public async Task A_second_stream_of_the_same_viewer_takes_over_and_the_first_is_told()
    {
        var run = await ArrangeAsync("live-stream-twice");
        using var app = factory.ClientFor(run.Sub);
        using var agent = AgentClient(run);

        using var stale = await OpenAsync(app, run);
        var staleEvents = new EventReader(stale);
        await PostFrameAsync(agent, run, 1, Frame(0x01));
        await staleEvents.UntilAsync(e => e.Name == "frame", "the first stream's picture");

        using var fresh = await OpenAsync(app, run);
        var freshEvents = new EventReader(fresh);

        await staleEvents.UntilAsync(e => e.Name == "superseded", "the first stream being told it was replaced");
        Assert.Null(await staleEvents.NextAsync());

        await PostFrameAsync(agent, run, 2, Frame(0x02));
        AssertFrame(await freshEvents.UntilAsync(e => e.Name == "frame" && e.Id == "2", "the second stream's picture"), 2, Frame(0x02));
    }

    [Fact]
    public async Task An_app_that_goes_away_takes_its_stream_with_it()
    {
        var run = await ArrangeAsync("live-stream-gone");
        using var app = factory.ClientFor(run.Sub);
        using var agent = AgentClient(run);
        var key = LiveStreamRelay.ViewerKey(run.UserId, Provider, run.SessionId, run.ChallengeId);

        var response = await OpenAsync(app, run);
        await PostFrameAsync(agent, run, 1, Frame(0x01));
        await new EventReader(response).UntilAsync(e => e.Name == "frame", "the picture");
        Assert.True(LiveStreamRelay.Holds(key));

        response.Dispose();

        await UntilAsync(() => !LiveStreamRelay.Holds(key), "the relay to let the stream go");
    }

    // ------------------------------------------------------------ the parts

    [Fact]
    public async Task The_reader_takes_events_as_the_format_writes_them_and_refuses_one_without_end()
    {
        var text = "retry: 1000\r\n\r\n: keep-alive\n\nid: 7\nevent: frame\ndata: {\"a\":\ndata: 1}\n\nevent: end\ndata: {}\n\nid: 8\nevent: fra";
        var reader = new SseReader(new MemoryStream(Encoding.UTF8.GetBytes(text)), 1024);

        Assert.True((await reader.ReadAsync(CancellationToken.None))!.IsComment);
        var frame = (await reader.ReadAsync(CancellationToken.None))!;
        Assert.Equal(("frame", "7", "{\"a\":\n1}"), (frame.Name, frame.Id, frame.Data));
        Assert.Equal("end", (await reader.ReadAsync(CancellationToken.None))!.Name);
        Assert.Null(await reader.ReadAsync(CancellationToken.None));

        var endless = new SseReader(new MemoryStream(Encoding.UTF8.GetBytes("data: " + new string('x', 5000))), 1024);
        await Assert.ThrowsAsync<InvalidDataException>(() => endless.ReadAsync(CancellationToken.None));
    }

    /// <summary>The app is handed the fields it draws with, rebuilt from what was checked, and nothing a frame could carry besides.</summary>
    [Fact]
    public void A_frame_is_handed_on_with_its_own_fields_and_a_wrong_one_not_at_all()
    {
        var jpeg = Convert.ToBase64String(Jpeg);
        var good = new SseEvent("frame", "5", $"{{\"sequence\":5,\"width\":390,\"height\":844,\"origin\":\"https://login.ah.nl\",\"jpeg\":\"{jpeg}\",\"extra\":\"no\"}}", false);

        var text = LiveStreamRelay.Render(good)!;
        Assert.StartsWith("id: 5\nevent: frame\ndata: ", text, StringComparison.Ordinal);
        var data = JsonNode.Parse(text.Split("data: ")[1].Trim())!.AsObject();
        Assert.Equal(["sequence", "width", "height", "origin", "jpeg"], data.Select(p => p.Key));
        Assert.Equal(Jpeg, Convert.FromBase64String(data["jpeg"]!.GetValue<string>()));

        Assert.Null(LiveStreamRelay.Render(good with { Id = "6" }));
        Assert.Null(LiveStreamRelay.Render(good with { Data = "{\"sequence\":5,\"width\":390,\"height\":844,\"jpeg\":\"!!\"}" }));
        Assert.Null(LiveStreamRelay.Render(good with { Data = "{\"sequence\":5,\"width\":0,\"height\":844,\"jpeg\":\"" + jpeg + "\"}" }));
        Assert.Null(LiveStreamRelay.Render(new SseEvent("message", null, "{}", false)));
        Assert.Equal(": keep-alive\n\n", LiveStreamRelay.Render(new SseEvent("message", null, null, true)));
        Assert.Contains("\"code\":\"challenge_expired\"", LiveStreamRelay.Render(new SseEvent("end", null, "garbage", false)), StringComparison.Ordinal);
    }

    // ------------------------------------------------------------- helpers

    private sealed record LiveRun(string Sub, Guid UserId, string SessionId, string JobId, string ChallengeId, string AgentToken);

    private static byte[] Frame(byte tag) => [.. Jpeg, tag];

    private static Task<HttpResponseMessage> OpenAsync(HttpClient app, LiveRun run, string? lastEventId = null)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Get, $"/connectors/{Provider}/login/{run.SessionId}/challenges/{run.ChallengeId}/live/stream");
        if (lastEventId is not null) request.Headers.TryAddWithoutValidation("Last-Event-ID", lastEventId);
        return app.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
    }

    private static async Task<JsonObject> ErrorOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.AsObject();

    private static void AssertFrame(StreamEvent frame, long sequence, byte[] bytes)
    {
        Assert.Equal(sequence.ToString(CultureInfo.InvariantCulture), frame.Id);
        var data = JsonNode.Parse(frame.Data!)!.AsObject();
        Assert.Equal(sequence, data["sequence"]!.GetValue<long>());
        Assert.Equal((390, 844), (data["width"]!.GetValue<int>(), data["height"]!.GetValue<int>()));
        Assert.Equal(bytes, Convert.FromBase64String(data["jpeg"]!.GetValue<string>()));
    }

    private HttpClient AgentClient(LiveRun run)
    {
        var client = factory.ControlPlane.Server.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", run.AgentToken);
        return client;
    }

    private static async Task PostFrameAsync(HttpClient agent, LiveRun run, long sequence, byte[] bytes)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/agent/v1/jobs/{run.JobId}/live/frame")
        {
            Content = new ByteArrayContent(bytes),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        request.Headers.TryAddWithoutValidation("X-Live-Sequence", sequence.ToString(CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation("X-Live-Size", "390x844");
        request.Headers.TryAddWithoutValidation("X-Live-Origin", "https://login.ah.nl");

        using var response = await agent.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// A person's session signing in, its job leased by an agent, a live
    /// challenge on it - staged on the control plane under the subject this
    /// API mints for the person, and bound to them here as a login would.
    /// </summary>
    private async Task<LiveRun> ArrangeAsync(string sub)
    {
        using (var first = factory.ClientFor(sub))
        {
            (await first.GetAsync("/connectors/sessions")).EnsureSuccessStatusCode();
        }

        var userId = factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
        var subject = new SubjectMinter(ConnectorApiFactory.SubjectSalt).For(userId);

        using var scope = factory.ControlPlane.Server.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
        var challenges = scope.ServiceProvider.GetRequiredService<ChallengeService>();

        var now = DateTimeOffset.UtcNow;
        var token = AgentAuth.NewToken();
        var agentId = Ids.New(Ids.Agent);
        db.Agents.Add(new AgentRow
        {
            Id = agentId,
            Name = "live-stream-test",
            OwnerSubject = subject,
            TokenHash = AgentAuth.Hash(token),
            LastHeartbeatAt = now,
            CreatedAt = now,
        });

        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = Provider,
            Subject = subject,
            State = SessionState.AwaitingInput,
            ExpiresAt = now.AddHours(1),
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Sessions.Add(session);
        await db.SaveChangesAsync();

        var job = await queue.EnqueueAsync(new NewJob { SessionId = session.Id, ProviderId = Provider, Kind = JobKind.Login }, CancellationToken.None);
        var row = await db.Jobs.FirstAsync(j => j.Id == job.Id);
        row.State = JobState.Leased;
        row.LeaseOwner = agentId;
        row.LeaseExpiresAt = now.AddMinutes(10);
        await db.SaveChangesAsync();

        var challenge = await challenges.RaiseAsync(job.Id, new PendingChallenge
        {
            Type = ChallengeType.LiveView,
            ExpiresAt = now.AddMinutes(5),
            Payload = new ChallengePayload { PromptKey = "connect.challenge.live_login" },
        }, CancellationToken.None);

        factory.Write(api => api.ConnectorSessions.Add(new ConnectorSession
        {
            Id = session.Id,
            UserId = userId,
            Provider = Provider,
            ConnectionId = $"conn-{sub}",
            State = "awaiting_input",
            CreatedAt = now,
            LastSeenAt = now,
        }));

        return new LiveRun(sub, userId, session.Id, job.Id, challenge.Id, token);
    }

    private async Task SettleAsync(LiveRun run)
    {
        using var scope = factory.ControlPlane.Server.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ChallengeService>()
            .AnswerAsync(run.ChallengeId, run.JobId, string.Empty, CancellationToken.None);
    }

    private async Task ExpireAsync(LiveRun run)
    {
        using var scope = factory.ControlPlane.Server.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ConnectorDbContext>().Challenges
            .Where(c => c.Id == run.ChallengeId)
            .ExecuteUpdateAsync(u => u.SetProperty(c => c.ExpiresAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
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

    private sealed record StreamEvent(string? Name, string? Id, string? Data, bool Comment);

    /// <summary>The app's side of the stream, an event at a time; every wait ends on what it waits for, under a generous deadline.</summary>
    private sealed class EventReader(HttpResponseMessage response)
    {
        private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(20);

        private readonly StreamReader _reader = new(response.Content.ReadAsStream());

        public async Task<StreamEvent> UntilAsync(Func<StreamEvent, bool> wanted, string what)
        {
            using var deadline = new CancellationTokenSource(Deadline);
            try
            {
                while (await NextAsync(deadline.Token) is { } next)
                {
                    if (wanted(next)) return next;
                }
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested)
            {
                throw new Xunit.Sdk.XunitException($"timed out waiting for {what}");
            }

            throw new Xunit.Sdk.XunitException($"the stream ended before {what}");
        }

        public async Task<StreamEvent?> NextAsync(CancellationToken ct = default)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(Deadline);

            string? name = null;
            string? id = null;
            string? data = null;
            var comment = false;

            while (await _reader.ReadLineAsync(deadline.Token) is { } line)
            {
                if (line.Length == 0)
                {
                    if (name is null && id is null && data is null && !comment) continue;
                    return new StreamEvent(name, id, data, comment && name is null && data is null);
                }

                if (line.StartsWith(':')) comment = true;
                else if (line.StartsWith("event: ", StringComparison.Ordinal)) name = line[7..];
                else if (line.StartsWith("id: ", StringComparison.Ordinal)) id = line[4..];
                else if (line.StartsWith("data: ", StringComparison.Ordinal)) data = line[6..];
            }

            return null;
        }
    }
}
