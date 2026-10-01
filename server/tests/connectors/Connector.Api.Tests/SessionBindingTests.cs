using System.Net;
using System.Text.Json;
using Connector.Api.Tests.Infrastructure;
using Connector.Kit.Manifests;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;

namespace Connector.Api.Tests;

/// <summary>
/// Every route that names something a user owns - a session, a job, a
/// ticket, an agent - answers only that user, named by the subject header.
/// Somebody else gets the answer a thing that does not exist gets, and a
/// relay that forgot the header is told so on its first call rather than
/// handed everybody's data.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class SessionBindingTests(ShopApiFactory factory)
{
    private const string Provider = RotatingStoreAdapter.ProviderId;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = RotatingStoreAdapter.Username,
        ["password"] = RotatingStoreAdapter.Password,
    };

    [Fact]
    public async Task A_session_answers_its_subject_and_nobody_else()
    {
        using var mine = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(mine, Provider, Flows.NewSubject("binding"), Credentials);
        using var theirs = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("stranger"));
        using var forgetful = factory.CreateAuthorizedClient();

        using (var own = await mine.GetAsync($"/v1/{Provider}/login/{connection.SessionId}"))
        {
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
        }

        await AssertUnknownAsync(theirs.GetAsync($"/v1/{Provider}/login/{connection.SessionId}"));
        await AssertUnknownAsync(theirs.PostAsync($"/v1/{Provider}/login/{connection.SessionId}/cancel", null));
        await AssertUnknownAsync(theirs.SendAsync(
            Wire.Post($"/v1/{Provider}/login/{connection.SessionId}/answer", new { challenge_id = "chl_x", value = "1" })));
        await AssertUnknownAsync(theirs.DeleteAsync($"/v1/{Provider}/sessions/{connection.SessionId}"));
        await AssertHeaderRequiredAsync(forgetful.GetAsync($"/v1/{Provider}/login/{connection.SessionId}"));

        // none of which touched it
        using var after = await mine.GetAsync($"/v1/{Provider}/login/{connection.SessionId}");
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
        Assert.Equal("active", (await after.JsonAsync()).Text("state"));
    }

    [Fact]
    public async Task A_ticket_and_the_job_behind_a_fetch_are_the_subjects_own()
    {
        using var mine = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(mine, Provider, Flows.NewSubject("ticket"), Credentials);
        var ticket = await Flows.ResumeAsync(mine, Provider, connection);
        using var theirs = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("stranger"));
        var url = $"/v1/{Provider}/{RotatingStoreAdapter.ReceiptsResource}?since=2026-06-01";

        using (var refused = await Flows.FetchAsync(theirs, url, ticket))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
            Assert.Equal("session_expired", await CodeAsync(refused));
        }

        await Flows.FetchPageAsync(mine, Provider, url, ticket);

        var jobId = Db.Read(factory, db => db.Jobs
            .Where(j => j.SessionId == connection.SessionId && j.Kind == JobKind.Fetch)
            .Select(j => j.Id)
            .First());

        using (var own = await mine.GetAsync($"/v1/{Provider}/jobs/{jobId}"))
        {
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
        }

        await AssertUnknownAsync(theirs.GetAsync($"/v1/{Provider}/jobs/{jobId}"));
        await AssertUnknownAsync(theirs.SendAsync(
            Wire.Post($"/v1/{Provider}/jobs/{jobId}/answer", new { challenge_id = "chl_x", value = "1" })));
    }

    [Fact]
    public async Task A_login_whose_header_and_body_name_different_subjects_is_refused_before_anything_runs()
    {
        using var http = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("header"));
        using var request = Wire.Post($"/v1/{Provider}/login", new { subject = Flows.NewSubject("body"), inputs = Credentials });

        using var response = await http.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_request", await CodeAsync(response));
    }

    [Fact]
    public async Task A_users_agents_are_their_own_and_the_operator_sees_every_one()
    {
        var owner = Flows.NewSubject("agents");
        var agent = Enroll(owner);
        using var mine = factory.CreateAuthorizedClient().ActAs(owner);
        using var theirs = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("stranger"));
        using var operatorSide = factory.CreateAuthorizedClient();

        Assert.Contains(agent, await AgentIdsAsync(mine, "/v1/agents"));
        Assert.DoesNotContain(agent, await AgentIdsAsync(theirs, "/v1/agents"));
        Assert.Contains(agent, await AgentIdsAsync(operatorSide, "/v1/admin/agents"));

        await AssertUnknownAsync(theirs.GetAsync($"/v1/agents/{agent}/profiles"));
        await AssertUnknownAsync(theirs.DeleteAsync($"/v1/agents/{agent}"));
        Assert.False(Revoked(agent), "a stranger revoked somebody else's agent");

        using var revoked = await mine.DeleteAsync($"/v1/agents/{agent}");
        Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        Assert.True(Revoked(agent));
    }

    private static async Task AssertUnknownAsync(Task<HttpResponseMessage> call)
    {
        using var response = await call;

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("unsupported_resource", await CodeAsync(response));
    }

    private static async Task AssertHeaderRequiredAsync(Task<HttpResponseMessage> call)
    {
        using var response = await call;

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_request", await CodeAsync(response));
    }

    private static async Task<string> CodeAsync(HttpResponseMessage response) =>
        (await response.JsonAsync()).GetProperty("error").Text("code");

    private static async Task<IReadOnlyList<string>> AgentIdsAsync(HttpClient http, string url)
    {
        using var response = await http.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var listed = (await response.JsonAsync()).GetProperty("agents");
        return [.. listed.EnumerateArray().Select(a => a.Text("id"))];
    }

    private bool Revoked(string agent) =>
        Db.Read(factory, db => db.Agents.Where(a => a.Id == agent).Select(a => a.Revoked).Single());

    private string Enroll(string owner)
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = "bound test agent",
            Class = AgentClass.Byo,
            OwnerSubject = owner,
            CapabilitiesJson = "{}",
            TokenHash = AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = now,
            CreatedAt = now,
        }));

        return id;
    }
}
