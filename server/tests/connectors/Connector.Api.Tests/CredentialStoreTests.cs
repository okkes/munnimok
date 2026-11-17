using System.Net;
using System.Text.Json;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// for sessions that cannot be refreshed (Jumbo: a fresh password within a day); a leaked password cannot be revoked from
/// here, so who can redeem the bundle and that it is never handed out twice matter most
[Collection(ShopApiCollection.Name)]
public sealed class CredentialStoreTests(ShopApiFactory factory)
{
    private const string Provider = DailyLoginAdapter.ProviderId;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = DailyLoginAdapter.Username,
        ["password"] = DailyLoginAdapter.Password,
    };

    [Fact]
    public async Task A_provider_that_offers_a_store_says_so_in_the_catalogue()
    {
        using var http = factory.CreateAuthorizedClient();

        using var response = await http.GetAsync($"/v1/providers/{Provider}");
        var manifest = await response.JsonAsync();

        Assert.True(manifest.GetProperty("offers_credential_store").GetBoolean());
    }

    [Fact]
    public async Task A_successful_login_hands_back_what_was_typed_sealed_for_this_device()
    {
        using var http = factory.CreateAuthorizedClient();

        var login = await LoginAsync(http, Flows.NewSubject("cred-mint"), Credentials);

        var bundle = login.GetProperty("credential_bundle").GetString();
        Assert.NotNull(bundle);
        Assert.StartsWith("cb_v1.", bundle, StringComparison.Ordinal);

        // the round trip would still pass if this became plaintext
        Assert.DoesNotContain(DailyLoginAdapter.Password, bundle, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Tomorrows_login_offers_the_bundle_instead_of_asking_again()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("cred-redeem");

        var first = await LoginAsync(http, subject, Credentials);
        var bundle = first.GetProperty("credential_bundle").GetString()!;

        var second = await LoginAsync(http, subject, inputs: null, credentialBundle: bundle);

        Assert.Equal("active", second.Text("state"));

        // the adapter echoes the username it was handed: proves the stored credential reached it
        Assert.Equal(
            DailyLoginAdapter.Username,
            second.GetProperty("provider_account").GetProperty("external_id").GetString());
    }

    [Fact]
    public async Task The_bundle_is_handed_over_once_and_then_forgotten()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("cred-once");

        var login = await LoginAsync(http, subject, Credentials);
        var sessionId = login.Text("session_id");

        Assert.NotNull(login.GetProperty("credential_bundle").GetString());

        using var poll = await http.GetAsync($"/v1/{Provider}/login/{sessionId}");
        var again = await poll.JsonAsync();

        Assert.False(
            again.TryGetProperty("credential_bundle", out var repeat) && repeat.ValueKind != JsonValueKind.Null,
            "a credential bundle must never be delivered twice");
    }

    /// a credential bundle is cleared when handed over, so one never fetched stayed on the row after disconnect
    /// while every other secret was purged
    [Fact]
    public async Task Disconnecting_forgets_a_credential_bundle_nobody_collected()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("cred-purge");

        var login = await LoginAsync(http, subject, Credentials);
        var sessionId = login.Text("session_id");

        Db.Write(factory, db =>
        {
            var session = db.Sessions.Single(s => s.Id == sessionId);
            session.PendingCredentialBundle = "cb_v1.uncollected";
            session.PendingBundle = "sb_v1.uncollected";
        });

        using var disconnect = await http.DeleteAsync($"/v1/{Provider}/sessions/{sessionId}");
        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);

        var left = Db.Read(factory, db => db.Sessions
            .Where(s => s.Id == sessionId)
            .Select(s => new { s.PendingBundle, s.PendingCredentialBundle })
            .Single());

        Assert.Null(left.PendingBundle);
        Assert.Null(left.PendingCredentialBundle);
    }

    /// the subject is part of the sealed blob's associated data: a lifted bundle is useless without being them
    [Fact]
    public async Task A_bundle_belonging_to_somebody_else_is_refused()
    {
        using var http = factory.CreateAuthorizedClient();

        var mine = await LoginAsync(http, Flows.NewSubject("cred-owner"), Credentials);
        var bundle = mine.GetProperty("credential_bundle").GetString()!;

        var thief = Flows.NewSubject("cred-thief");
        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject = thief,
            credential_bundle = bundle,
        });

        // The relay names the thief consistently; the bundle is the owner's.
        using var response = await http.ActAs(thief).SendAsync(request);

        await ErrorEnvelope.AssertAsync(response, HttpStatusCode.Unauthorized, "session_expired");
    }

    [Theory]
    [InlineData("not-a-bundle")]
    [InlineData("cb_v1.k1.AAAA.BBBB.CCCC")]
    public async Task A_bundle_that_does_not_open_is_refused_rather_than_ignored(string bundle)
    {
        using var http = factory.CreateAuthorizedClient();

        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject = Flows.NewSubject("cred-garbage"),
            credential_bundle = bundle,
        });

        using var response = await http.SendAsync(request);

        // refused, not downgraded to "no inputs": a stale stored credential must prompt for a password, not an invalid_request
        await ErrorEnvelope.AssertAsync(response, HttpStatusCode.Unauthorized, "session_expired");
    }

    /// a caller sending both is taken at what it typed: the bundle is a memory of an older form
    [Fact]
    public async Task What_was_typed_now_wins_over_what_was_remembered()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("cred-both");

        var first = await LoginAsync(http, subject, Credentials);
        var bundle = first.GetProperty("credential_bundle").GetString()!;

        var wrong = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = DailyLoginAdapter.Username,
            ["password"] = "the-password-was-changed",
        };

        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject,
            inputs = wrong,
            credential_bundle = bundle,
        });

        using var response = await http.SendAsync(request);

        // had the stored one won, the user would be signed in with a credential they had just replaced
        await ErrorEnvelope.AssertAsync(response, HttpStatusCode.Unauthorized, "invalid_credentials");
    }

    [Fact]
    public async Task A_provider_that_offers_no_store_hands_back_no_bundle()
    {
        using var http = factory.CreateAuthorizedClient();

        var login = await LoginAsync(
            http,
            Flows.NewSubject("cred-absent"),
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = RotatingStoreAdapter.Username,
                ["password"] = RotatingStoreAdapter.Password,
            },
            provider: RotatingStoreAdapter.ProviderId);

        Assert.False(
            login.TryGetProperty("credential_bundle", out var bundle) && bundle.ValueKind != JsonValueKind.Null,
            "a provider whose session refreshes itself must not store a password");
    }

    private static async Task<JsonElement> LoginAsync(
        HttpClient http,
        string subject,
        IReadOnlyDictionary<string, string>? inputs,
        string? credentialBundle = null,
        string? provider = null)
    {
        http.ActAs(subject);
        using var request = Wire.Post($"/v1/{provider ?? Provider}/login", new
        {
            subject,
            inputs,
            credential_bundle = credentialBundle,
        });

        using var response = await http.SendAsync(request);
        var body = await response.JsonAsync();

        Assert.True(
            response.IsSuccessStatusCode,
            $"expected the login to succeed, got {(int)response.StatusCode}: {body}");

        return body;
    }
}
