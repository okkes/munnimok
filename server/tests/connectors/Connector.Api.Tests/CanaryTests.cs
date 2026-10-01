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

/// <summary>
/// The operator's own connection, run on a schedule.
///
/// Every other health signal here is reactive - a provider is marked degraded
/// when a real user's fetch comes back <c>provider_changed</c>. That works and
/// it has a hole in the middle of it: the first person to find out is a person.
/// A canary is a user who is always there.
///
/// It is also the only credential this platform keeps at rest, so half of what
/// follows is about the size of that exception rather than about whether the
/// schedule works.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class CanaryTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Simple;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    // ---- the exception, and its size --------------------------------------

    /// <summary>
    /// A CONNECTION BELONGING TO A PERSON CANNOT BE ENROLLED HERE.
    /// </summary>
    /// <remarks>
    /// The load-bearing check, and the one worth being explicit about: this
    /// table is the single place the platform holds a credential at rest, and
    /// the mistake it guards against is not an attacker. It is an operator with
    /// a support ticket open, a user's bundle on their clipboard, and a
    /// reasonable-sounding idea about reproducing a fault.
    /// <para>
    /// A bundle only opens against the subject it was sealed for, so demanding
    /// the marker at enrolment makes a real user's connection unusable here
    /// even if somebody pastes one in: a consumer's subject is an HMAC and will
    /// never carry it.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_connection_belonging_to_a_person_cannot_be_enrolled_as_a_canary()
    {
        using var http = factory.CreateAuthorizedClient();

        // Exactly what a consumer's own login produces, with no marker on it.
        var theirs = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("a-real-person"), Credentials);

        using var refused = await EnrolAsync(http, Provider, theirs.Subject, theirs.Bundle, "receipts", 60);

        await ErrorEnvelope.AssertAsync(refused, HttpStatusCode.BadRequest, "invalid_request");

        // And nothing was written on the way to refusing. Asserted against the
        // subject rather than against an empty table, because these tests share
        // a host and a provider: "no canary at all" would be a claim about
        // whichever test ran last.
        Assert.DoesNotContain(
            Db.Read(factory, db => db.Canaries.ToList()),
            c => string.Equals(c.Subject, theirs.Subject, StringComparison.Ordinal));
    }

    /// <summary>
    /// The bundle goes in and does not come back out.
    /// </summary>
    /// <remarks>
    /// A response carrying it would put a live credential into every proxy log
    /// between here and the operator, for no reason at all: they already have
    /// it, they just sent it.
    /// </remarks>
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

        // Nor does listing them.
        Assert.DoesNotContain(
            operatorConnection.Bundle,
            JsonSerializer.Serialize(await ListAsync(http)),
            StringComparison.Ordinal);
    }

    // ---- the schedule's own rules -----------------------------------------

    /// <summary>
    /// A canary is a real session against a real provider, and one that runs
    /// too often gets the operator's own account blocked - which would take the
    /// canary out and teach nobody anything.
    /// </summary>
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

    /// <summary>
    /// A resource the provider does not have is refused rather than enrolled to
    /// fail later.
    /// </summary>
    /// <remarks>
    /// The refusal names the resources that DO exist - the mistake is almost
    /// always a typo - but it names them in the operator's log rather than in
    /// the response, because the error envelope carries codes and keys and no
    /// prose at all. That is the platform's rule and this is not the place to
    /// make an exception to it: a caller cannot render an English sentence, and
    /// a field that sometimes holds one is a field somebody eventually shows a
    /// user.
    /// </remarks>
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

    // ---- what it actually does --------------------------------------------

    /// <summary>
    /// THE WHOLE POINT: a run happens with nobody present, and says what it
    /// found.
    /// </summary>
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

    /// <summary>
    /// A CANARY KEEPS THE BUNDLE ITS RUN HANDED BACK.
    /// </summary>
    /// <remarks>
    /// The subtle one, and the one that would have been found in production
    /// rather than here. Most providers issue a fresh bundle on every fetch and
    /// invalidate the one that was used, so a canary that kept the original
    /// would open it once and fail every time after - and fail with
    /// <c>provider_changed</c>, which degrades the provider for every real user
    /// too. A monitor that manufactures the outage it is watching for is worse
    /// than no monitor.
    /// <para>
    /// Asserted as "two runs in a row both come back", because that is the
    /// property; the bundle changing is only how it is achieved.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_second_run_works_because_the_first_ones_bundle_was_kept()
    {
        // The provider that ACTUALLY rotates - RotatesOnUse - because on one
        // that does not, this test would pass without the rotation code
        // existing at all.
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

        // The one the run handed back, not the one the operator sent.
        var held = Db.Read(factory, db => db.Canaries.Single(c => c.ProviderId == Rotating).Bundle);

        Assert.NotEqual(operatorConnection.Bundle, held);

        // Due again. The second run must work from what was kept - the bundle
        // the operator originally sent has been spent and will no longer open.
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

    /// <summary>
    /// A provider an operator has deliberately backed away from gets no canary
    /// traffic either. Pausing is the kill switch, and a monitor that ignored
    /// it would keep hitting the provider exactly when somebody has decided to
    /// stop.
    /// </summary>
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

    /// <summary>
    /// Removing a canary removes the credential with it, rather than leaving a
    /// live provider session in the table with nothing running against it.
    /// </summary>
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

    // ---- helpers -----------------------------------------------------------

    /// <summary>
    /// Connects the way an operator would: their own account, under a subject
    /// carrying the marker.
    /// </summary>
    private static async Task<Connection> ConnectAsOperatorAsync(HttpClient http, string label) =>
        await Flows.ConnectAsync(
            http, Provider, $"{CanaryService.SubjectPrefix}{Flows.NewSubject(label)}", Credentials);

    /// <summary>
    /// Serialised through <see cref="Wire"/> rather than with the default
    /// options, so the test speaks the published snake-case contract and a
    /// casing regression cannot pass by both sides moving together.
    /// </summary>
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

    /// <summary>
    /// One sweep starts the run; a later one reads it. Separate on purpose -
    /// see <see cref="CanaryScheduler"/> - so this drives both rather than
    /// pretending a fetch is instant.
    /// </summary>
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
