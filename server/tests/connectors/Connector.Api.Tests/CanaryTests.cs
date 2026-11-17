using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Manifests;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// the operator's own connection run on a schedule: the proactive signal beside reactive health, and the only credential
/// this platform keeps at rest
[Collection(ShopApiCollection.Name)]
public sealed class CanaryTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Simple;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    /// a person's connection cannot be enrolled: the marker is demanded,
    /// and a consumer's subject is an HMAC that never carries it
    [Fact]
    public async Task A_connection_belonging_to_a_person_cannot_be_enrolled_as_a_canary()
    {
        using var http = factory.CreateAuthorizedClient();

        var theirs = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("a-real-person"), Credentials);

        using var refused = await EnrolAsync(http, Provider, theirs.Subject, theirs.Bundle, "receipts", 60);

        await ErrorEnvelope.AssertAsync(refused, HttpStatusCode.BadRequest, "invalid_request");

        // asserted against the subject, not an empty table: these tests share a host and a provider
        Assert.DoesNotContain(
            Db.Read(factory, db => db.Canaries.ToList()),
            c => string.Equals(c.Subject, theirs.Subject, StringComparison.Ordinal));
    }

    /// the bundle goes in and never comes out: a response would put a live credential in every proxy log
    [Fact]
    public async Task An_enrolment_never_echoes_the_bundle_it_was_given()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await ConnectAsOperatorAsync(http, "no-echo");

        using var enrolled = await EnrolAsync(
            http, Provider, operatorConnection.Subject, operatorConnection.Bundle, "receipts", 60);

        Assert.Equal(HttpStatusCode.OK, enrolled.StatusCode);

        var body = await enrolled.Content.ReadAsStringAsync();

        Assert.DoesNotContain(operatorConnection.Bundle, body, StringComparison.Ordinal);
        Assert.DoesNotContain("bundle", body, StringComparison.OrdinalIgnoreCase);

        Assert.DoesNotContain(
            operatorConnection.Bundle,
            JsonSerializer.Serialize(await ListAsync(http)),
            StringComparison.Ordinal);
    }

    /// a canary is a real session: running too often gets the operator's own account blocked
    [Fact]
    public async Task An_interval_below_the_floor_is_refused()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await ConnectAsOperatorAsync(http, "too-often");

        using var refused = await EnrolAsync(
            http, Provider, operatorConnection.Subject, operatorConnection.Bundle, "receipts",
            CanaryService.MinimumIntervalMinutes - 1);

        await ErrorEnvelope.AssertAsync(refused, HttpStatusCode.BadRequest, "invalid_request");
    }

    /// the refusal names existing resources in the operator's log, not the response:
    /// the error envelope carries codes and keys, never prose
    [Fact]
    public async Task An_unknown_resource_is_refused_rather_than_enrolled_to_fail_later()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await ConnectAsOperatorAsync(http, "typo");

        using var refused = await EnrolAsync(
            http, Provider, operatorConnection.Subject, operatorConnection.Bundle, "reciepts", 60);

        await ErrorEnvelope.AssertAsync(refused, HttpStatusCode.BadRequest, "invalid_request");

        Assert.DoesNotContain(
            Db.Read(factory, db => db.Canaries.ToList()),
            c => string.Equals(c.ResourceId, "reciepts", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_canary_runs_without_anybody_present_and_reports_what_it_found()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await ConnectAsOperatorAsync(http, "runs");

        using (var enrolled = await EnrolAsync(
            http, Provider, operatorConnection.Subject, operatorConnection.Bundle, "receipts", 60))
        {
            Assert.Equal(HttpStatusCode.OK, enrolled.StatusCode);
        }

        await RunToVerdictAsync();

        var canary = Assert.Single(await ListAsync(http), c => c.GetProperty("provider_id").GetString() == Provider);

        Assert.True(
            canary.GetProperty("intact").GetBoolean(),
            $"the canary did not come back: {canary.GetProperty("verdict")}");

        Assert.Equal("read receipts and parsed what came back", canary.GetProperty("verdict").GetString());
        Assert.False(string.IsNullOrWhiteSpace(canary.GetProperty("last_job_id").GetString()));
    }

    /// most providers rotate the bundle on every fetch: keeping the original would fail the next run with provider_changed
    /// and degrade the provider for every real user
    [Fact]
    public async Task A_second_run_works_because_the_first_ones_bundle_was_kept()
    {
        // the provider that ACTUALLY rotates (RotatesOnUse): on one that does not, this passes without the rotation code
        const string Rotating = RotatingStoreAdapter.ProviderId;

        var credentials = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = RotatingStoreAdapter.Username,
            ["password"] = RotatingStoreAdapter.Password,
        };

        using var http = factory.CreateAuthorizedClient();

        var operatorConnection = await Flows.ConnectAsync(
            http, Rotating, $"{CanaryService.SubjectPrefix}{Flows.NewSubject("rotates")}", credentials);

        using (await EnrolAsync(
            http, Rotating, operatorConnection.Subject, operatorConnection.Bundle, "receipts", 60))
        {
        }

        await RunToVerdictAsync(Rotating);

        var held = Db.Read(factory, db => db.Canaries.Single(c => c.ProviderId == Rotating).Bundle);

        Assert.NotEqual(operatorConnection.Bundle, held);

        // the second run must work from what was kept: the original bundle is spent
        Db.Write(factory, db =>
        {
            var row = db.Canaries.Single(c => c.ProviderId == Rotating);
            row.LastRunAt = DateTimeOffset.UtcNow.AddDays(-1);
            row.LastIntact = null;
            row.LastJobId = null;
        });

        await RunToVerdictAsync(Rotating);

        var canary = Assert.Single(await ListAsync(http), c => c.GetProperty("provider_id").GetString() == Rotating);

        Assert.True(
            canary.GetProperty("intact").GetBoolean(),
            $"the second run did not come back: {canary.GetProperty("verdict")}");
    }

    /// pausing is the kill switch: a paused provider gets no canary traffic
    [Fact]
    public async Task A_paused_provider_gets_no_canary_run()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await ConnectAsOperatorAsync(http, "paused");

        using (await EnrolAsync(
            http, Provider, operatorConnection.Subject, operatorConnection.Bundle, "receipts", 60))
        {
        }

        using (var request = Wire.Post(
            $"/v1/admin/providers/{Provider}/status", new { state = "paused", reasonKey = "connect.paused" }))
        using (var paused = await http.SendAsync(request))
        {
            Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
        }

        try
        {
            await SweepAsync();
            await SweepAsync();

            Assert.Null(Db.Read(factory, db => db.Canaries.Single(c => c.ProviderId == Provider).LastJobId));
        }
        finally
        {
            using var request = Wire.Post(
                $"/v1/admin/providers/{Provider}/status", new { state = "healthy", reasonKey = (string?)null });

            using var healthy = await http.SendAsync(request);
        }
    }

    /// removing a canary removes its credential rather than leaving a live provider session in the table
    [Fact]
    public async Task Removing_a_canary_removes_what_it_was_holding()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await ConnectAsOperatorAsync(http, "removed");

        using (await EnrolAsync(
            http, Provider, operatorConnection.Subject, operatorConnection.Bundle, "receipts", 60))
        {
        }

        using (var removed = await http.DeleteAsync($"/v1/admin/providers/{Provider}/canary"))
        {
            Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        }

        Assert.Empty(Db.Read(factory, db => db.Canaries.Where(c => c.ProviderId == Provider).ToList()));

        using var again = await http.DeleteAsync($"/v1/admin/providers/{Provider}/canary");
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
    }

    private static async Task<Connection> ConnectAsOperatorAsync(HttpClient http, string label) =>
        await Flows.ConnectAsync(
            http, Provider, $"{CanaryService.SubjectPrefix}{Flows.NewSubject(label)}", Credentials);

    /// serialised through Wire so the test speaks the snake-case contract:
    /// a casing regression cannot pass by both sides moving
    private static async Task<HttpResponseMessage> EnrolAsync(
        HttpClient http, string provider, string subject, string bundle, string resource, int minutes)
    {
        using var request = Wire.Put(
            $"/v1/admin/providers/{provider}/canary",
            new { subject, bundle, resource, intervalMinutes = minutes });

        return await http.SendAsync(request);
    }

    private static async Task<List<JsonElement>> ListAsync(HttpClient http)
    {
        using var response = await http.GetAsync("/v1/admin/canaries");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        return [.. body.GetProperty("canaries").EnumerateArray()];
    }

    /// one sweep starts the run, a later one reads it - separate on purpose, see CanaryScheduler
    private async Task RunToVerdictAsync(string provider = Provider)
    {
        await SweepAsync();

        for (var attempt = 0; attempt < 40; attempt++)
        {
            await SweepAsync();

            if (Db.Read(factory, db => db.Canaries.Single(c => c.ProviderId == provider).LastIntact) is not null)
            {
                return;
            }

            await Task.Delay(50);
        }

        Assert.Fail($"the canary for {provider} never reached a verdict");
    }

    private Task SweepAsync() =>
        factory.Services.GetServices<IHostedService>().OfType<CanaryScheduler>().Single()
            .SweepAsync(CancellationToken.None);
}
