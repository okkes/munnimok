using System.Net;
using BankConnector.Adapters.MockBank;
using Connector.Api.Tests.Infrastructure;
using Connector.Kit.Hosting.Endpoints;

namespace Connector.Api.Tests;

/// <summary>
/// The aggregator shape on the wire (#414), walked against the consent mock:
/// a lookup field's options and vendored logo, a login that is a redirect
/// answered with the bank's return, the party's budget on the status
/// document after a fetch, and the operator's inventory at the party.
/// </summary>
public sealed class LookupRouteTests(ShopApiFactory factory) : IClassFixture<ShopApiFactory>
{
    private const string Provider = MockBankConsentAdapter.ProviderId;
    private const string ReturnUrl = "https://app.test/gc-callback";

    [Fact]
    public async Task A_lookup_field_lists_the_party_s_options_and_vendors_a_logo_once()
    {
        using var http = factory.CreateAuthorizedClient();

        using var all = await http.GetAsync($"/v1/{Provider}/options/institution?country=NL");
        Assert.Equal(HttpStatusCode.OK, all.StatusCode);
        var options = (await all.JsonAsync()).GetProperty("options").EnumerateArray().ToList();
        Assert.Equal(2, options.Count);
        Assert.Equal(MockBankConsentAdapter.Institution, options[0].Text("value"));
        Assert.Equal(MockBankConsentAdapter.InstitutionName, options[0].Text("label"));
        Assert.True(options[0].GetProperty("has_logo").GetBoolean());
        Assert.False(options[1].GetProperty("has_logo").GetBoolean());

        using var some = await http.GetAsync($"/v1/{Provider}/options/institution?q=plain");
        Assert.Single((await some.JsonAsync()).GetProperty("options").EnumerateArray());

        // the value travels as a base64url token: a party may name an option in ways no route segment admits
        using var logo = await http.GetAsync($"/v1/{Provider}/options/institution/{LookupToken.Encode(MockBankConsentAdapter.Institution)}/logo");
        Assert.Equal(HttpStatusCode.OK, logo.StatusCode);
        Assert.Equal("image/png", logo.ContentType()?.MediaType);
        Assert.Contains("immutable", logo.Headers.CacheControl?.ToString());
        Assert.Equal(8, (await logo.Content.ReadAsByteArrayAsync()).Length);
        Assert.Equal("ASN Bank|NL", LookupToken.Decode(LookupToken.Encode("ASN Bank|NL")));

        using var none = await http.GetAsync($"/v1/{Provider}/options/institution/{LookupToken.Encode("mock-institution-plain")}/logo");
        Assert.Equal(HttpStatusCode.NotFound, none.StatusCode);
        using var garbage = await http.GetAsync($"/v1/{Provider}/options/institution/not-a-token!/logo");
        Assert.Equal(HttpStatusCode.NotFound, garbage.StatusCode);

        // a party that lists nothing at connect time says so in the envelope
        using var unsupported = await http.GetAsync($"/v1/{MockBankSimpleAdapter.ProviderId}/options/institution");
        await ErrorEnvelope.AssertAsync(unsupported, HttpStatusCode.BadRequest, "unsupported_resource");
    }

    [Fact]
    public async Task A_consent_is_a_redirect_the_return_answers_and_the_party_s_budget_reaches_the_status_document()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("consent");
        http.ActAs(subject);

        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            Subject = subject,
            Inputs = new Dictionary<string, string> { ["country"] = "NL", ["institution"] = MockBankConsentAdapter.Institution },
            Config = new Dictionary<string, string> { ["return_url"] = ReturnUrl },
        });
        using var login = await http.SendAsync(request);
        var accepted = await login.JsonAsync();
        Assert.True(login.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, $"login answered {(int)login.StatusCode}: {accepted}");
        var sessionId = accepted.Text("session_id");
        var awaiting = string.Equals(accepted.TextOrNull("state"), "awaiting_input", StringComparison.Ordinal)
            ? accepted
            : await Flows.AwaitStateAsync(http, Provider, sessionId, "awaiting_input");
        var challenge = awaiting.GetProperty("challenge");
        Assert.Equal("redirect", challenge.Text("type"));
        Assert.StartsWith(MockBankConsentAdapter.ConsentPage, challenge.Text("url"), StringComparison.Ordinal);
        Assert.Equal(ReturnUrl + "*", challenge.Text("return_pattern"));
        var code = challenge.Text("code");
        Assert.StartsWith("mcr_", code, StringComparison.Ordinal);

        // the return page hands the landing url back as the answer
        using var answerRequest = Wire.Post($"/v1/{Provider}/login/{sessionId}/answer",
            new { ChallengeId = challenge.Text("id"), Value = $"{ReturnUrl}?ref={code}" });
        using var answer = await http.SendAsync(answerRequest);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);

        var bundle = await Flows.AwaitBundleAsync(http, Provider, sessionId);
        var settled = await Flows.AwaitStateAsync(http, Provider, sessionId, "active");
        Assert.Equal(MockBankConsentAdapter.InstitutionName, settled.GetProperty("provider_account").Text("display_name"));

        // a fetch over the consent: the party reports its budget, the status document carries it
        var ticket = await Flows.ResumeAsync(http, Provider, new Connection(subject, sessionId, bundle));
        await Flows.FetchPageAsync(http, Provider, $"/v1/{Provider}/accounts", ticket);   // asserts the fetch succeeded

        using var status = await http.GetAsync("/v1/status");
        var party = (await status.JsonAsync()).GetProperty("providers").EnumerateArray()
            .Single(p => p.Text("provider_id") == Provider);
        var quota = party.GetProperty("quota");
        Assert.Equal(4, quota.GetProperty("limit").GetInt32());
        Assert.Equal(3, quota.GetProperty("remaining").GetInt32());
        Assert.True(quota.GetProperty("reset_at").TryGetDateTimeOffset(out _));
        var plain = (await status.JsonAsync()).GetProperty("providers").EnumerateArray()
            .Single(p => p.Text("provider_id") == MockBankSimpleAdapter.ProviderId);
        Assert.False(plain.TryGetProperty("quota", out _));   // a party that never said anything about its budget carries none
    }

    [Fact]
    public async Task The_operator_s_inventory_at_the_party_lists_every_consent_and_revokes_one()
    {
        using var http = factory.CreateAuthorizedClient();

        using var before = await http.GetAsync($"/v1/admin/providers/{Provider}/remote-consents");
        Assert.Equal(HttpStatusCode.OK, before.StatusCode);
        var consents = (await before.JsonAsync()).GetProperty("consents").EnumerateArray().ToList();
        Assert.Equal(2, consents.Count);
        var foreign = consents.Single(c => c.Text("id") == "mock-consent-elsewhere");
        Assert.Equal("https://other.mock.invalid", foreign.Text("origin"));
        Assert.Equal("EX", foreign.Text("status"));
        Assert.Equal("legacy", foreign.Text("reference"));
        Assert.Equal(0, foreign.GetProperty("account_count").GetInt32());

        using var revoked = await http.DeleteAsync($"/v1/admin/providers/{Provider}/remote-consents/mock-consent-elsewhere");
        Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        using var after = await http.GetAsync($"/v1/admin/providers/{Provider}/remote-consents");
        Assert.Single((await after.JsonAsync()).GetProperty("consents").EnumerateArray());

        using var none = await http.GetAsync($"/v1/admin/providers/{MockBankSimpleAdapter.ProviderId}/remote-consents");
        await ErrorEnvelope.AssertAsync(none, HttpStatusCode.BadRequest, "unsupported_resource");
    }
}
