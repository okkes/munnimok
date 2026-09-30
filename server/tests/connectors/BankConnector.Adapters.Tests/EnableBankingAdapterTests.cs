using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BankConnector.Adapters.OpenBanking;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// Enable Banking as a party (#414): the RS256 request signing, institutions
/// named by name|country, the consent born from the bank's single-use code,
/// the wire's directions and references turned into the ingest's identities,
/// the revoke.
/// </summary>
public sealed class EnableBankingAdapterTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 30, 12, 0, 0, TimeSpan.Zero);
    private const string ReturnUrl = "https://app.test/gc-callback";

    private static readonly RSA Key = RSA.Create(2048);

    private static EnableBankingOptions Options => new()
    {
        ApplicationId = "app-1234",
        // the env file's one-line form: literal \n between the lines
        PrivateKeyPem = Key.ExportPkcs8PrivateKeyPem().Replace("\n", "\\n", StringComparison.Ordinal),
        BaseUrl = "https://eb.test",
    };

    private static EnableBankingAdapter Adapter(TimeProvider? time = null) => new(Options, time ?? new FixedTime(Now));

    private static StubHttpHandler Wire(Func<RecordedRequest, HttpResponseMessage?>? override_ = null) => new((req, _) =>
    {
        if (override_?.Invoke(req) is { } answer) return answer;
        var path = req.Path;
        return path switch
        {
            "/aspsps" => Stub.Json("""{"aspsps":[{"name":"ASN Bank","country":"NL","logo":"https://cdn.test/asn.png","transaction_total_days":90},{"name":"PayPal","country":"NL","logo":null,"transaction_total_days":30}]}"""),
            "/auth" => Stub.Json("""{"url":"https://eb.test/consent/xyz"}"""),
            "/sessions" => Stub.Json("""{"session_id":"ses1","accounts":[{"uid":"u1"},{"uid":null}]}"""),
            "/sessions/ses1" when req.Method == HttpMethod.Delete => Stub.Status(HttpStatusCode.OK),
            "/accounts/u1/details" => Stub.Json("""{"account_id":{"iban":"NL02ASNB0000000002"},"name":"Betalen","currency":"EUR"}"""),
            "/accounts/u1/balances" => Stub.Json("""{"balances":[{"balance_amount":{"amount":"250.10","currency":"EUR"},"balance_type":"CLBD","reference_date":"2026-09-29"}]}"""),
            "/accounts/u1/transactions" when !req.Query.Contains("continuation_key", StringComparison.Ordinal) && req.Query.Contains("date_from", StringComparison.Ordinal) =>
                Stub.Json("""
                {"transactions":[
                   {"entry_reference":"ref-1","transaction_amount":{"amount":"20.00","currency":"EUR"},"credit_debit_indicator":"DBIT","status":"BOOK","booking_date":"2026-09-20","creditor":{"name":"Jumbo"},"remittance_information":["Boodschappen","week 38"]},
                   {"entry_reference":null,"transaction_amount":{"amount":"5.00","currency":"EUR"},"credit_debit_indicator":"CRDT","status":"PDNG","transaction_date":"2026-09-30","debtor":{"name":"Someone"}}
                 ],"continuation_key":"page2"}
                """),
            "/accounts/u1/transactions" when req.Query.Contains("continuation_key=page2", StringComparison.Ordinal) =>
                Stub.Json("""{"transactions":[{"entry_reference":"ref-3","transaction_amount":{"amount":"1.00","currency":"EUR"},"credit_debit_indicator":"CRDT","status":"BOOK","booking_date":"2026-09-19"}],"continuation_key":null}"""),
            _ => Stub.Status(HttpStatusCode.NotFound, $"unscripted {req.Method} {path}{req.Query}"),
        };
    });

    private static FakeJobContext Login(StubHttpHandler wire, Func<Challenge, string>? answer = null) => new(wire)
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal) { ["country"] = "NL", ["institution"] = "ASN Bank|NL" },
        Config = new Dictionary<string, string>(StringComparer.Ordinal) { ["return_url"] = ReturnUrl },
        Answer = answer ?? (challenge => $"{ReturnUrl}?state={challenge.Code}&code=abc123"),
    };

    private static SessionMaterial Consent() => new ConsentMaterial
    {
        ConsentId = "ses1",
        InstitutionId = "ASN Bank|NL",
        InstitutionName = "ASN Bank",
        Accounts = [new ConsentAccount { Id = "u1", Iban = "NL02ASNB0000000002", Name = "Betalen", Currency = "EUR", Detailed = true }],
    }.ToMaterial();

    [Fact]
    public void The_manifest_validates_and_names_institutions_by_name_and_country()
    {
        var m = Adapter().Describe();
        ManifestValidator.Validate(m);
        Assert.Equal("enablebanking", m.Id);
        Assert.Equal(ProviderRuntime.Http, m.Runtime);
        Assert.Equal(SecretCustody.Server, m.SecretCustody);
        Assert.Equal(AuthFlow.OauthRedirect, m.Auth.Flow);
        Assert.True(m.UnattendedFetch);
    }

    [Fact]
    public async Task Every_call_carries_a_signed_token_the_application_key_verifies_and_reuses()
    {
        var wire = Wire();
        var adapter = Adapter();
        using var http = new HttpClient(wire);
        var options = await adapter.LookupAsync(http, "institution", new LookupQuery { Context = new Dictionary<string, string> { ["country"] = "NL" } }, CancellationToken.None);
        Assert.Equal(["ASN Bank|NL", "PayPal|NL"], options.Select(o => o.Value));
        Assert.Equal([true, false], options.Select(o => o.HasLogo));

        var bearer = wire.Requests[0].Header("Authorization")!;
        Assert.StartsWith("Bearer ", bearer);
        var parts = bearer["Bearer ".Length..].Split('.');
        Assert.Equal(3, parts.Length);
        using var header = JsonDocument.Parse(Base64Url(parts[0]));
        Assert.Equal("RS256", header.RootElement.GetProperty("alg").GetString());
        Assert.Equal("app-1234", header.RootElement.GetProperty("kid").GetString());
        using var payload = JsonDocument.Parse(Base64Url(parts[1]));
        Assert.Equal("enablebanking.com", payload.RootElement.GetProperty("iss").GetString());
        Assert.Equal("api.enablebanking.com", payload.RootElement.GetProperty("aud").GetString());
        Assert.Equal(Now.ToUnixTimeSeconds(), payload.RootElement.GetProperty("iat").GetInt64());
        Assert.Equal(Now.AddHours(1).ToUnixTimeSeconds(), payload.RootElement.GetProperty("exp").GetInt64());
        Assert.True(Key.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), Base64Url(parts[2]), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));

        // the second call reuses the token; nothing is re-imported or re-signed
        await adapter.LookupAsync(http, "institution", new LookupQuery { Text = "pay", Context = new Dictionary<string, string> { ["country"] = "DE" } }, CancellationToken.None);
        Assert.Equal(bearer, wire.Requests[1].Header("Authorization"));
    }

    [Fact]
    public async Task The_consent_is_born_from_the_code_the_bank_returns_with()
    {
        var wire = Wire();
        using var ctx = Login(wire);
        var result = await Adapter().LoginAsync(ctx, CancellationToken.None);

        using var auth = JsonDocument.Parse(wire.Requests.Single(r => r.Path == "/auth").Body!);
        Assert.Equal("ASN Bank", auth.RootElement.GetProperty("aspsp").GetProperty("name").GetString());
        Assert.Equal("NL", auth.RootElement.GetProperty("aspsp").GetProperty("country").GetString());
        Assert.Equal(ReturnUrl, auth.RootElement.GetProperty("redirect_url").GetString());
        Assert.Equal("personal", auth.RootElement.GetProperty("psu_type").GetString());
        Assert.StartsWith("ebr_", auth.RootElement.GetProperty("state").GetString());
        Assert.Equal(Now.AddDays(90).ToString("o"), auth.RootElement.GetProperty("access").GetProperty("valid_until").GetString());

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal("https://eb.test/consent/xyz", challenge.Url);
        Assert.Equal(auth.RootElement.GetProperty("state").GetString(), challenge.Code);

        using var session = JsonDocument.Parse(wire.Requests.Single(r => r.Path == "/sessions").Body!);
        Assert.Equal("abc123", session.RootElement.GetProperty("code").GetString());
        Assert.Equal("ses1", result.Material.Extra["consent_id"]);
        Assert.Equal("ASN Bank", result.Account?.DisplayName);
        Assert.Equal("u1", Assert.Single(result.Reachable).ExternalId);   // a uid-less entry is not an account
        Assert.Contains("NL02ASNB0000000002", result.Material.Extra["accounts"]);

        var noCode = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(Login(Wire(), _ => $"{ReturnUrl}?state=x"), CancellationToken.None));
        Assert.Equal(ErrorCode.InvalidRequest, noCode.Code);   // the state names another consent

        var spent = Wire(req => req.Path == "/sessions" ? Stub.Status(HttpStatusCode.BadRequest, """{"error":"ALREADY_AUTHORIZED"}""") : null);
        var used = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(Login(spent), CancellationToken.None));
        Assert.Equal(ErrorCode.ChallengeExpired, used.Code);
    }

    [Fact]
    public async Task A_fetch_pages_flips_debits_derives_a_reference_where_the_bank_gives_none_and_maps_balances()
    {
        var wire = Wire();
        using var ctx = new FakeJobContext(wire) { Material = Consent() };
        var adapter = Adapter();

        var accounts = await adapter.FetchAsync(ctx, new ResourceRequest { ResourceId = "accounts" }, CancellationToken.None);
        var account = Assert.Single(accounts.Accounts);
        Assert.Equal(25_010, account.Balance?.Amount.Value);
        Assert.Equal(new DateTimeOffset(2026, 9, 29, 0, 0, 0, TimeSpan.Zero), account.Balance?.AsOf);
        Assert.Equal(0, wire.Count("GET", "/accounts/u1/details"));   // the login already learned them

        var transactions = await adapter.FetchAsync(ctx, new ResourceRequest { ResourceId = "transactions", Since = new DateOnly(2026, 9, 10) }, CancellationToken.None);
        Assert.Equal(2, wire.Count("GET", "/accounts/u1/transactions"));   // two pages
        var ids = transactions.Transactions.Select(t => t.ExternalId).ToList();
        Assert.Contains("ref-1", ids);
        Assert.Contains("ref-3", ids);
        var pending = Assert.Single(transactions.Transactions, t => t.ExternalId.StartsWith("pending:eb:", StringComparison.Ordinal));
        Assert.Equal("pending:eb:".Length + 24, pending.ExternalId.Length);   // 24 hex characters, the api's derivation
        Assert.Equal(500, pending.Amount.Value);
        Assert.Equal(new DateOnly(2026, 9, 30), pending.BookedAt);   // transaction_date stands in for a booking day
        var debit = transactions.Transactions.Single(t => t.ExternalId == "ref-1");
        Assert.Equal(-2000, debit.Amount.Value);
        Assert.Equal("Jumbo", debit.Counterparty?.Name);
        Assert.Equal("Boodschappen week 38", debit.Description);
        Assert.Empty(ctx.Quotas);   // this aggregator publishes no budget
    }

    [Fact]
    public async Task An_out_of_range_window_answered_empty_is_retried_on_the_bank_s_own_window()
    {
        var calls = 0;
        var wire = Wire(req =>
        {
            if (req.Path != "/accounts/u1/transactions") return null;
            calls++;
            return req.Query.Contains("date_from", StringComparison.Ordinal)
                ? Stub.Json("""{"transactions":[],"continuation_key":null}""")
                : Stub.Json("""{"transactions":[{"entry_reference":"only","transaction_amount":{"amount":"2.00","currency":"EUR"},"credit_debit_indicator":"CRDT","status":"BOOK","booking_date":"2026-09-29"}],"continuation_key":null}""");
        });
        using var ctx = new FakeJobContext(wire) { Material = Consent() };
        var result = await Adapter().FetchAsync(ctx, new ResourceRequest { ResourceId = "transactions", Since = new DateOnly(2026, 9, 1) }, CancellationToken.None);
        Assert.Equal(2, calls);
        Assert.Equal("only", Assert.Single(result.Transactions).ExternalId);
    }

    [Fact]
    public async Task Logout_deletes_the_session_and_an_ended_session_reads_as_an_ended_consent()
    {
        var wire = Wire();
        using var ctx = new FakeJobContext(wire) { Material = Consent() };
        await Adapter().LogoutAsync(ctx, CancellationToken.None);
        Assert.Equal(1, wire.Count("DELETE", "/sessions/ses1"));

        var ended = Wire(req => req.Path == "/accounts/u1/balances" ? Stub.Status(HttpStatusCode.Forbidden, """{"error":"session expired"}""") : null);
        using var ctx2 = new FakeJobContext(ended) { Material = Consent() };
        var expired = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(ctx2, new ResourceRequest { ResourceId = "accounts" }, CancellationToken.None));
        Assert.Equal(ErrorCode.ConsentExpired, expired.Code);
        Assert.Contains("session expired", expired.Detail);
    }

    private static byte[] Base64Url(string text)
    {
        var padded = text.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch { 2 => "==", 3 => "=", _ => string.Empty };
        return Convert.FromBase64String(padded);
    }
}
