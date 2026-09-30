using System.Net;
using System.Text.Json;
using BankConnector.Adapters.OpenBanking;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// GoCardless as a party (#414): the institution list the person picks
/// from, the consent as a redirect answered by the bank's return, the
/// accounts and transactions over the consent with the identities the
/// consumer's ingest already keys on, the budget read back, the revoke,
/// and the operator's inventory of the aggregator account.
/// </summary>
public sealed class GoCardlessAdapterTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 30, 12, 0, 0, TimeSpan.Zero);
    private const string ReturnUrl = "https://app.test/gc-callback";

    private static GoCardlessOptions Options => new() { SecretId = "sid", SecretKey = "skey", BaseUrl = "https://gc.test/api/v2/" };

    private static GoCardlessAdapter Adapter(TimeProvider? time = null) => new(Options, time ?? new FixedTime(Now));

    private const string Institutions = """
        [{"id":"ING_INGBNL2A","name":"ING","transaction_total_days":"730","logo":"https://cdn.test/ing.png"},
         {"id":"ABNAMRO_ABNANL2A","name":"ABN AMRO","transaction_total_days":"90","logo":null}]
        """;

    /// <summary>The aggregator's wire, scripted by path; every answer is the happy one unless a test overrides it.</summary>
    private static StubHttpHandler Wire(Func<RecordedRequest, HttpResponseMessage?>? override_ = null) => new((req, _) =>
    {
        if (override_?.Invoke(req) is { } answer) return answer;
        var path = req.Path;
        return path switch
        {
            _ when path.EndsWith("/token/new/", StringComparison.Ordinal) => Stub.Json("""{"access":"tok","access_expires":3600}"""),
            _ when path.EndsWith("/institutions/", StringComparison.Ordinal) => Stub.Json(Institutions),
            _ when path.EndsWith("/institutions/ING_INGBNL2A/", StringComparison.Ordinal) => Stub.Json("""{"id":"ING_INGBNL2A","name":"ING","transaction_total_days":"730","logo":"https://cdn.test/ing.png"}"""),
            _ when path.EndsWith("/agreements/enduser/", StringComparison.Ordinal) => Stub.Json("""{"id":"agr1"}"""),
            _ when path.EndsWith("/requisitions/", StringComparison.Ordinal) && req.Method == HttpMethod.Post =>
                Stub.Json("""{"id":"req1","link":"https://gc.test/psd2/start/req1/ING","status":"CR"}"""),
            _ when path.EndsWith("/requisitions/", StringComparison.Ordinal) => Stub.Json("""
                {"results":[
                  {"id":"req1","status":"LN","institution_id":"ING_INGBNL2A","created":"2026-09-01T10:00:00Z","reference":"gcr_1","accounts":["acc1"],"redirect":"https://app.test/gc-callback"},
                  {"id":"req9","status":"EX","institution_id":"ING_INGBNL2A","created":"2026-05-01T10:00:00Z","reference":"legacy","accounts":[],"redirect":"https://munni-prod.example/gc-callback"}
                ]}
                """),
            _ when path.EndsWith("/requisitions/req1/", StringComparison.Ordinal) && req.Method == HttpMethod.Delete => Stub.Status(HttpStatusCode.OK),
            _ when path.EndsWith("/requisitions/req1/", StringComparison.Ordinal) => Stub.Json("""{"id":"req1","status":"LN","accounts":["acc1"]}"""),
            _ when path.EndsWith("/accounts/acc1/details/", StringComparison.Ordinal) =>
                Stub.Json("""{"account":{"iban":"NL91ABNA0417164300","name":"Betaalrekening","currency":"EUR"}}"""),
            _ when path.EndsWith("/accounts/acc1/balances/", StringComparison.Ordinal) => Stub.Json("""
                {"balances":[{"balanceAmount":{"amount":"12.50","currency":"EUR"},"balanceType":"interimBooked","referenceDate":"2026-09-30"},
                             {"balanceAmount":{"amount":"10.00","currency":"EUR"},"balanceType":"closingBooked","referenceDate":"2026-09-29"}]}
                """),
            _ when path.EndsWith("/accounts/acc1/transactions/", StringComparison.Ordinal) =>
                WithQuota(Stub.Json("""
                {"transactions":{"booked":[
                   {"transactionId":"txid1","bookingDate":"2026-09-28","valueDate":"2026-09-28","transactionAmount":{"amount":"-15.00","currency":"EUR"},"creditorName":"Albert Heijn","remittanceInformationUnstructured":"Boodschappen<br>filiaal 1234","creditorAccount":{"iban":"NL00AHOL0000000001"}},
                   {"internalTransactionId":"int2","bookingDate":"2026-09-27","transactionAmount":{"amount":"100.00","currency":"EUR"},"debtorName":"Werkgever BV"},
                   {"transactionAmount":{"amount":"1.00","currency":"EUR"},"creditorName":"no reference no day"}
                 ],"pending":[
                   {"transactionId":"p1","valueDate":"2026-09-30","transactionAmount":{"amount":"-3.20","currency":"EUR"},"creditorName":"NS"}
                 ]}}
                """), limit: 4, remaining: 2, reset: 3600),
            _ when path.EndsWith("/ing.png", StringComparison.Ordinal) => Stub.Bytes([0x89, 0x50, 0x4E, 0x47], "image/png"),
            _ => Stub.Status(HttpStatusCode.NotFound, $"unscripted {req.Method} {path}"),
        };
    });

    private static HttpResponseMessage WithQuota(HttpResponseMessage response, int limit, int remaining, int reset)
    {
        response.Headers.TryAddWithoutValidation("x-ratelimit-account-success-limit", limit.ToString());
        response.Headers.TryAddWithoutValidation("x-ratelimit-account-success-remaining", remaining.ToString());
        response.Headers.TryAddWithoutValidation("x-ratelimit-account-success-reset", reset.ToString());
        return response;
    }

    private static FakeJobContext Login(StubHttpHandler wire, Func<Challenge, string>? answer = null, IReadOnlyDictionary<string, string>? config = null) => new(wire)
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal) { ["country"] = "NL", ["institution"] = "ING_INGBNL2A" },
        Config = config ?? new Dictionary<string, string>(StringComparer.Ordinal) { ["return_url"] = ReturnUrl },
        Answer = answer ?? (challenge => $"{ReturnUrl}?ref={challenge.Code}"),
    };

    [Fact]
    public void The_manifest_is_an_inline_http_party_under_server_custody_with_the_consent_as_a_redirect()
    {
        var m = Adapter().Describe();
        ManifestValidator.Validate(m);
        Assert.Equal("gocardless", m.Id);
        Assert.Equal(ProviderKind.Bank, m.Kind);
        Assert.Equal(ProviderRuntime.Http, m.Runtime);
        Assert.False(m.Agent.Required);
        Assert.Equal(AgentClass.Inline, m.Agent.Class);
        Assert.True(m.UnattendedFetch);
        Assert.Equal(SecretCustody.Server, m.SecretCustody);
        Assert.Equal(LogoutSupport.Account, m.Logout);
        Assert.Equal(AuthFlow.OauthRedirect, m.Auth.Flow);
        Assert.Equal([ChallengeType.Redirect], m.Auth.Challenges);
        var step = Assert.Single(m.Auth.Steps);
        Assert.Equal(["country", "institution"], step.Fields.Select(f => f.Key));
        Assert.Equal(FieldType.Select, step.Fields[0].Type);
        Assert.Equal(FieldType.Lookup, step.Fields[1].Type);
        Assert.Equal("return_url", Assert.Single(m.Auth.Config).Key);
        Assert.True(m.Auth.Session.Refreshable);
        Assert.Equal(90 * 86_400, m.Auth.Session.TtlSeconds);
        Assert.False(m.Auth.Reauth.Cheap);
        Assert.Contains("consent_expired", m.Auth.Reauth.TriggerCodes);
        Assert.Equal(3, m.Limits.PreferredFetchHourLocal);
        Assert.Equal(730, m.Limits.MaxHistoryDays);
        Assert.Equal(3, m.Limits.SettlementLagDays);
        Assert.Equal(["accounts", "transactions"], m.Resources.Select(r => r.Id));
    }

    [Fact]
    public async Task The_lookup_lists_the_party_s_institutions_for_the_country_and_vendors_a_logo_once()
    {
        var wire = Wire();
        var adapter = Adapter();
        using var http = new HttpClient(wire);

        var all = await adapter.LookupAsync(http, "institution", new LookupQuery { Context = new Dictionary<string, string> { ["country"] = "nl" } }, CancellationToken.None);
        Assert.Equal(["ABN AMRO", "ING"], all.Select(o => o.Label));
        Assert.Equal(["ABNAMRO_ABNANL2A", "ING_INGBNL2A"], all.Select(o => o.Value));
        Assert.Equal([false, true], all.Select(o => o.HasLogo));
        Assert.Contains("country=NL", wire.Requests.Single(r => r.Path.EndsWith("/institutions/", StringComparison.Ordinal)).Query);

        var some = await adapter.LookupAsync(http, "institution", new LookupQuery { Text = "ing" }, CancellationToken.None);
        Assert.Equal(["ING"], some.Select(o => o.Label));
        Assert.Equal(1, wire.Count("GET", "/institutions/"));   // the list is cached for the day

        var logo = await adapter.LookupLogoAsync(http, "institution", "ING_INGBNL2A", CancellationToken.None);
        Assert.NotNull(logo);
        Assert.Equal("image/png", logo.ContentType);
        Assert.Equal(4, logo.Bytes.Length);
        Assert.Null(await adapter.LookupLogoAsync(http, "institution", "ABNAMRO_ABNANL2A", CancellationToken.None));

        await Assert.ThrowsAsync<ConnectorException>(() => adapter.LookupAsync(http, "iban", new LookupQuery(), CancellationToken.None));
    }

    [Fact]
    public async Task The_login_asks_the_aggregator_for_a_consent_and_finishes_on_the_bank_s_return()
    {
        var wire = Wire();
        using var ctx = Login(wire);

        var result = await Adapter().LoginAsync(ctx, CancellationToken.None);

        // the requisition carries the consumer's return page and an agreement for the institution's full history
        var requisition = wire.Requests.Single(r => r.Method == HttpMethod.Post && r.Path.EndsWith("/requisitions/", StringComparison.Ordinal));
        using var body = JsonDocument.Parse(requisition.Body!);
        Assert.Equal(ReturnUrl, body.RootElement.GetProperty("redirect").GetString());
        Assert.Equal("ING_INGBNL2A", body.RootElement.GetProperty("institution_id").GetString());
        Assert.Equal("agr1", body.RootElement.GetProperty("agreement").GetString());
        var reference = body.RootElement.GetProperty("reference").GetString();
        Assert.StartsWith("gcr_", reference);
        using var agreement = JsonDocument.Parse(wire.Requests.Single(r => r.Path.EndsWith("/agreements/enduser/", StringComparison.Ordinal)).Body!);
        Assert.Equal(730, agreement.RootElement.GetProperty("max_historical_days").GetInt32());

        // the challenge names where to go, where the bank comes back and what to look for
        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.Redirect, challenge.Type);
        Assert.Equal("https://gc.test/psd2/start/req1/ING", challenge.Url);
        Assert.Equal(ReturnUrl + "*", challenge.ReturnPattern);
        Assert.Equal(reference, challenge.Code);
        Assert.Equal(Now.AddMinutes(20), challenge.ExpiresAt);

        // the consent is the requisition; the material holds it and the accounts with their details, never a secret
        Assert.Equal("ING", result.Account?.DisplayName);
        Assert.Equal("req1", result.Account?.ExternalId);
        Assert.Equal(Now.AddDays(90), result.ExpiresAt);
        var reachable = Assert.Single(result.Reachable);
        Assert.Equal("acc1", reachable.ExternalId);
        Assert.Equal("Betaalrekening", reachable.DisplayName);
        Assert.Null(result.Material.AccessToken);
        Assert.Equal("req1", result.Material.Extra["consent_id"]);
        Assert.Contains("NL91ABNA0417164300", result.Material.Extra["accounts"]);
        Assert.Contains("\"detailed\":true", result.Material.Extra["accounts"]);
        Assert.Contains(JobStep.AwaitingHuman, ctx.Steps);
        Assert.Equal(1, wire.Count("POST", "/token/new/"));   // one token for the whole login
    }

    [Fact]
    public async Task A_login_without_a_return_page_a_bank_that_refused_or_a_consent_not_linked_says_which()
    {
        var noReturn = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(
            Login(Wire(), config: new Dictionary<string, string>(StringComparer.Ordinal)), CancellationToken.None));
        Assert.Equal(ErrorCode.InvalidRequest, noReturn.Code);
        Assert.Contains("return_url", noReturn.Detail);

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(
            Login(Wire(), answer: _ => $"{ReturnUrl}?error=access_denied"), CancellationToken.None));
        Assert.Equal(ErrorCode.ChallengeExpired, refused.Code);

        var other = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(
            Login(Wire(), answer: _ => $"{ReturnUrl}?ref=gcr_somebody_else"), CancellationToken.None));
        Assert.Equal(ErrorCode.InvalidRequest, other.Code);

        var unfinished = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(
            Login(Wire(req => req.Path.EndsWith("/requisitions/req1/", StringComparison.Ordinal) && req.Method == HttpMethod.Get
                ? Stub.Json("""{"id":"req1","status":"GA","accounts":[]}""") : null)), CancellationToken.None));
        Assert.Equal(ErrorCode.ChallengeExpired, unfinished.Code);

        var expired = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(
            Login(Wire(req => req.Path.EndsWith("/requisitions/req1/", StringComparison.Ordinal) && req.Method == HttpMethod.Get
                ? Stub.Json("""{"id":"req1","status":"EX","accounts":[]}""") : null)), CancellationToken.None));
        Assert.Equal(ErrorCode.ConsentExpired, expired.Code);
    }

    private static SessionMaterial Consent(bool detailed) => new ConsentMaterial
    {
        ConsentId = "req1",
        InstitutionId = "ING_INGBNL2A",
        InstitutionName = "ING",
        Accounts = [detailed
            ? new ConsentAccount { Id = "acc1", Iban = "NL91ABNA0417164300", Name = "Betaalrekening", Currency = "EUR", Detailed = true }
            : new ConsentAccount { Id = "acc1" }],
    }.ToMaterial();

    [Fact]
    public async Task A_fetch_reads_details_once_balances_always_and_keeps_the_identities_the_ingest_keys_on()
    {
        var wire = Wire();
        using var ctx = new FakeJobContext(wire) { Material = Consent(detailed: false) };
        var adapter = Adapter();

        var accounts = await adapter.FetchAsync(ctx, new ResourceRequest { ResourceId = "accounts" }, CancellationToken.None);
        var account = Assert.Single(accounts.Accounts);
        Assert.Equal("acc1", account.ExternalId);
        Assert.Equal("NL91ABNA0417164300", account.Iban);
        Assert.Equal("4300", account.MaskedNumber);
        Assert.Equal(AccountType.Current, account.Type);
        Assert.Equal("Betaalrekening", account.DisplayName);
        Assert.Equal(1000, account.Balance?.Amount.Value);   // closingBooked wins over interimBooked
        Assert.NotNull(accounts.RefreshedMaterial);            // the details were learned: the session keeps them
        Assert.Contains("\"detailed\":true", accounts.RefreshedMaterial.Extra["accounts"]);
        Assert.Equal("api", accounts.Via);

        // the platform re-seals what a fetch learned into the session; the next job carries it
        using var next = new FakeJobContext(wire) { Material = accounts.RefreshedMaterial };
        var since = new DateOnly(2026, 9, 1);
        var transactions = await adapter.FetchAsync(next, new ResourceRequest { ResourceId = "transactions", Since = since }, CancellationToken.None);
        // the window widens by the settlement lag; the aggregator gets it as date_from
        Assert.Contains("date_from=2026-08-29", wire.Requests.Single(r => r.Path.EndsWith("/accounts/acc1/transactions/", StringComparison.Ordinal)).Query);
        Assert.Equal(["int2", "txid1", "pending:p1"], transactions.Transactions.Select(t => t.ExternalId));
        var outgoing = transactions.Transactions.Single(t => t.ExternalId == "txid1");
        Assert.Equal(-1500, outgoing.Amount.Value);
        Assert.Equal("Albert Heijn", outgoing.Counterparty?.Name);
        Assert.Equal("NL00AHOL0000000001", outgoing.Counterparty?.Iban);
        Assert.Equal("Boodschappen filiaal 1234", outgoing.Description);
        var incoming = transactions.Transactions.Single(t => t.ExternalId == "int2");
        Assert.Equal(10_000, incoming.Amount.Value);
        Assert.Equal("Werkgever BV", incoming.Counterparty?.Name);
        Assert.Equal("Werkgever BV", incoming.Description);
        var pending = transactions.Transactions.Single(t => t.ExternalId == "pending:p1");
        Assert.Equal(new DateOnly(2026, 9, 30), pending.BookedAt);
        Assert.True(transactions.Complete);
        Assert.Contains(next.Notes, n => n.Contains("1 row(s)", StringComparison.Ordinal));
        Assert.Null(transactions.RefreshedMaterial);            // nothing new learned this time
        Assert.Equal(1, wire.Count("GET", "/accounts/acc1/details/"));   // details once, over both fetches
        Assert.Equal(2, wire.Count("GET", "/accounts/acc1/balances/"));  // balances every time

        var quota = Assert.Single(next.Quotas);
        Assert.Equal(4, quota.Limit);
        Assert.Equal(2, quota.Remaining);
        Assert.Equal(Now.AddSeconds(3600), quota.ResetAt);
        Assert.Equal(Now, quota.SeenAt);
    }

    [Fact]
    public async Task The_party_s_budget_and_an_ended_consent_come_back_as_their_own_codes()
    {
        var limited = Wire(req => req.Path.EndsWith("/accounts/acc1/transactions/", StringComparison.Ordinal)
            ? WithQuota(Stub.Status(HttpStatusCode.TooManyRequests), 4, 0, 1800) : null);
        using var ctx = new FakeJobContext(limited) { Material = Consent(detailed: true) };
        var rateLimited = await Assert.ThrowsAsync<ConnectorException>(() =>
            Adapter().FetchAsync(ctx, new ResourceRequest { ResourceId = "transactions" }, CancellationToken.None));
        Assert.Equal(ErrorCode.RateLimited, rateLimited.Code);
        Assert.Equal(1800, rateLimited.RetryAfterSeconds);

        var ended = Wire(req => req.Path.EndsWith("/accounts/acc1/balances/", StringComparison.Ordinal) ? Stub.Status(HttpStatusCode.Unauthorized) : null);
        using var ctx2 = new FakeJobContext(ended) { Material = Consent(detailed: true) };
        var expired = await Assert.ThrowsAsync<ConnectorException>(() =>
            Adapter().FetchAsync(ctx2, new ResourceRequest { ResourceId = "accounts" }, CancellationToken.None));
        Assert.Equal(ErrorCode.ConsentExpired, expired.Code);

        // a budget refusal on the details leaves the account undetailed for the next fetch rather than failing it
        var detailsLimited = Wire(req => req.Path.EndsWith("/accounts/acc1/details/", StringComparison.Ordinal) ? Stub.Status(HttpStatusCode.TooManyRequests) : null);
        using var ctx3 = new FakeJobContext(detailsLimited) { Material = Consent(detailed: false) };
        var partial = await Adapter().FetchAsync(ctx3, new ResourceRequest { ResourceId = "accounts" }, CancellationToken.None);
        Assert.Equal("ING", Assert.Single(partial.Accounts).DisplayName);
        Assert.Null(partial.RefreshedMaterial);
    }

    [Fact]
    public async Task Logout_revokes_the_consent_and_the_inventory_lists_what_the_aggregator_account_holds()
    {
        var wire = Wire();
        using var ctx = new FakeJobContext(wire) { Material = Consent(detailed: true) };
        var adapter = Adapter();
        await adapter.LogoutAsync(ctx, CancellationToken.None);
        Assert.Equal(1, wire.Count("DELETE", "/requisitions/req1/"));

        var gone = Wire(req => req.Method == HttpMethod.Delete ? Stub.Status(HttpStatusCode.NotFound) : null);
        using var ctx2 = new FakeJobContext(gone) { Material = Consent(detailed: true) };
        await adapter.LogoutAsync(ctx2, CancellationToken.None);   // already revoked is the goal state

        using var http = new HttpClient(wire);
        var consents = await adapter.ListRemoteAsync(http, CancellationToken.None);
        Assert.Equal(2, consents.Count);
        Assert.Equal("https://app.test", consents[0].Origin);
        Assert.Equal("https://munni-prod.example", consents[1].Origin);
        Assert.Equal("legacy", consents[1].Reference);
        Assert.Equal("EX", consents[1].Status);
        Assert.Equal(1, consents[0].AccountCount);
        await adapter.RevokeRemoteAsync(http, "req1", CancellationToken.None);
        Assert.Equal(2, wire.Count("DELETE", "/requisitions/req1/"));
    }

    [Fact]
    public void The_party_exists_only_when_the_operator_holds_an_account_there()
    {
        var none = BankAdapters.Real(new BankAdapterOptions()).Select(a => a.Describe().Id);
        Assert.DoesNotContain("gocardless", none);
        Assert.DoesNotContain("enablebanking", none);
        var both = BankAdapters.Real(new BankAdapterOptions
        {
            GoCardless = Options,
            EnableBanking = new EnableBankingOptions { ApplicationId = "app", PrivateKeyPem = "-----BEGIN PRIVATE KEY-----" },
        }).Select(a => a.Describe().Id).ToList();
        Assert.Contains("gocardless", both);
        Assert.Contains("enablebanking", both);
    }
}
