using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Munni.Api.Connectors;
using Munni.Api.Sync;

namespace Munni.Api.Tests.Connectors;

/// <summary>The relay's pieces on their own: subjects, casing, budgets, the client's headers and envelopes, the event frames.</summary>
public class ConnectorUnitTests
{
    [Fact]
    public void A_subject_is_deterministic_per_salt_and_opaque()
    {
        var user = Guid.Parse("6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b");
        var minter = new SubjectMinter("salt-one");

        var subject = minter.For(user);
        Assert.Equal(subject, minter.For(user));
        Assert.StartsWith(SubjectMinter.Prefix, subject, StringComparison.Ordinal);
        Assert.Equal(23, subject.Length);
        Assert.DoesNotContain(user.ToString("D"), subject, StringComparison.OrdinalIgnoreCase);
        Assert.Matches("^u_[A-Za-z0-9_-]{21}$", subject);

        // another environment's salt is another subject: a rotation severs every connection
        Assert.NotEqual(subject, new SubjectMinter("salt-two").For(user));
        // and another user is another subject
        Assert.NotEqual(subject, minter.For(Guid.NewGuid()));
    }

    [Fact]
    public void Options_refuse_a_relay_that_cannot_be_right_and_wait_for_a_credential_not_written_back_yet()
    {
        // a setting that cannot be right refuses to start with its name
        Assert.Throws<InvalidOperationException>(() => new ConnectorOptions { BaseUrl = "http://c/" }.Require());
        Assert.Throws<InvalidOperationException>(() => new ConnectorOptions { BaseUrl = "not a url", SubjectSalt = "s", DevKey = "k" }.Require());
        Assert.Throws<InvalidOperationException>(() => new ConnectorOptions { BaseUrl = "http://c/", SubjectSalt = "s", M2mAppId = "a" }.Require());
        Assert.Throws<InvalidOperationException>(() => new ConnectorOptions { BaseUrl = "http://c/", SubjectSalt = "s", M2mAppId = "a", M2mAppSecret = "b" }.Require());

        // the machine pair arrives with the platform's write-back: a stage, not a fault
        var waiting = new ConnectorOptions { BaseUrl = "http://c/", SubjectSalt = "s", Audience = "https://connector" };
        waiting.Require();
        Assert.False(waiting.HasCredential);

        new ConnectorOptions { BaseUrl = "http://c", SubjectSalt = "s", DevKey = "k" }.Require();
        var machine = new ConnectorOptions { BaseUrl = "http://c", SubjectSalt = "s", M2mAppId = "a", M2mAppSecret = "b", Audience = "https://connector" };
        machine.Require();
        Assert.True(machine.HasCredential);
        // unconfigured is simply absent, never an error
        new ConnectorOptions().Require();
        Assert.Equal("http://c/", new ConnectorOptions { BaseUrl = "http://c" }.BaseAddress().AbsoluteUri);
    }

    [Fact]
    public void Registration_reports_absent_waiting_or_enabled()
    {
        var absent = new ConfigurationBuilder().Build();
        Assert.Equal(ConnectorPresence.Absent, ConnectorSetup.Register(new Microsoft.Extensions.DependencyInjection.ServiceCollection(), absent));

        var waiting = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Connectors:BaseUrl"] = "http://connector:8080/",
            ["Connectors:SubjectSalt"] = "salt",
            ["Connectors:Audience"] = "https://connector",
        }).Build();
        Assert.Equal(ConnectorPresence.WaitingForCredential, ConnectorSetup.Register(new Microsoft.Extensions.DependencyInjection.ServiceCollection(), waiting));

        var enabled = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Connectors:BaseUrl"] = "http://connector:8080/",
            ["Connectors:SubjectSalt"] = "salt",
            ["Connectors:DevKey"] = "k",
        }).Build();
        Assert.Equal(ConnectorPresence.Enabled, ConnectorSetup.Register(new Microsoft.Extensions.DependencyInjection.ServiceCollection(), enabled));
    }

    [Fact]
    public void Connector_documents_are_rendered_in_camel_case_except_their_data_keys()
    {
        var node = JsonNode.Parse("""
            {"session_id":"ses_1","provider_account":{"display_name":"Shop","external_id":"x"},
             "config":{"client_id":"keep_me"},"inputs":{"user_name":"typed"},
             "steps_done":["opening_provider"],"nested":[{"a_b":1}]}
            """)!;

        var camel = (JsonObject)ConnectorJson.ToCamel(node)!;
        Assert.Equal("ses_1", camel["sessionId"]!.GetValue<string>());
        Assert.Equal("Shop", camel["providerAccount"]!["displayName"]!.GetValue<string>());
        Assert.Equal("keep_me", camel["config"]!["client_id"]!.GetValue<string>());
        Assert.Equal("typed", camel["inputs"]!["user_name"]!.GetValue<string>());
        Assert.Equal("opening_provider", camel["stepsDone"]![0]!.GetValue<string>());
        Assert.Equal(1, camel["nested"]![0]!["aB"]!.GetValue<int>());

        // and the other direction, for a body the app wrote
        var snake = (JsonObject)ConnectorJson.ToSnake(JsonNode.Parse("""{"events":[{"deltaY":2,"kind":"scroll"}]}"""))!;
        Assert.Equal(2, snake["events"]![0]!["delta_y"]!.GetValue<int>());

        Assert.Equal("sessionId", ConnectorJson.CamelCase("session_id"));
        Assert.Equal("plain", ConnectorJson.CamelCase("plain"));
        Assert.Equal("retry_after_seconds", ConnectorJson.SnakeCase("retryAfterSeconds"));
    }

    [Fact]
    public void A_stream_frame_carries_the_view_without_anything_a_bundle_rides_in()
    {
        var view = (JsonObject)ConnectorJson.ToCamel(JsonNode.Parse("""
            {"session_id":"ses_1","state":"active","bundle":"sb_v1.secret","credential_bundle":"cb.secret",
             "session":{"bundle":"sb_v1.rotated","rotated":true},"data":[{"id":"rcp_1"}],"progress":{"step":"done"}}
            """))!;

        var frame = JsonNode.Parse(ConnectorEventBridge.Frame("mock-store-simple", "ses_1", "job_1", view))!.AsObject();
        Assert.Equal("connector", frame["kind"]!.GetValue<string>());
        Assert.Equal("mock-store-simple", frame["provider"]!.GetValue<string>());
        Assert.Equal("ses_1", frame["sessionId"]!.GetValue<string>());
        Assert.Equal("job_1", frame["jobId"]!.GetValue<string>());
        Assert.Equal("done", frame["progress"]!["step"]!.GetValue<string>());
        Assert.DoesNotContain("secret", frame.ToJsonString(), StringComparison.Ordinal);
        Assert.DoesNotContain("rotated", frame.ToJsonString(), StringComparison.Ordinal);
        Assert.Null(frame["data"]);
    }

    [Fact]
    public void The_events_route_writes_a_user_frame_only_to_its_user()
    {
        var me = Guid.NewGuid();
        var spaces = new HashSet<string> { "space-a" };

        Assert.Equal(": keepalive\n\n", SyncEndpoints.FrameFor(null, me, spaces));
        Assert.Equal("data: {\"spaceId\":\"space-a\"}\n\n", SyncEndpoints.FrameFor(new SyncEvent("space-a", null, null), me, spaces));
        Assert.Null(SyncEndpoints.FrameFor(new SyncEvent("space-b", null, null), me, spaces));
        Assert.Equal("data: {\"kind\":\"connector\"}\n\n", SyncEndpoints.FrameFor(new SyncEvent(null, me, "{\"kind\":\"connector\"}"), me, spaces));
        Assert.Null(SyncEndpoints.FrameFor(new SyncEvent(null, Guid.NewGuid(), "{\"kind\":\"connector\"}"), me, spaces));
    }

    [Fact]
    public void The_budget_is_a_sliding_hour_per_user_and_kind()
    {
        var clock = new TestClock(DateTimeOffset.Parse("2026-09-29T12:00:00Z"));
        var budget = new ConnectorBudget(new ConnectorOptions { LoginsPerHour = 2, SyncsPerHour = 1 }, clock);
        var user = Guid.NewGuid();

        Assert.True(budget.TrySpend(user, ConnectorBudget.Login, out _));
        Assert.True(budget.TrySpend(user, ConnectorBudget.Login, out _));
        Assert.False(budget.TrySpend(user, ConnectorBudget.Login, out var retryAfter));
        Assert.InRange(retryAfter, 3599, 3600);

        // another kind, another user: their own budgets
        Assert.True(budget.TrySpend(user, ConnectorBudget.Sync, out _));
        Assert.False(budget.TrySpend(user, ConnectorBudget.Sync, out _));
        Assert.True(budget.TrySpend(Guid.NewGuid(), ConnectorBudget.Login, out _));

        clock.Advance(TimeSpan.FromMinutes(61));
        Assert.True(budget.TrySpend(user, ConnectorBudget.Login, out _));
    }

    [Fact]
    public async Task The_client_stamps_the_development_key_the_subject_and_the_per_call_headers()
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"session_id":"ses_1","state":"active"}""", Encoding.UTF8, "application/json"),
        });
        var client = Client(handler, new ConnectorOptions { BaseUrl = "http://c/", SubjectSalt = "s", DevKey = "dev-key" });

        var reply = await client.PostAsync("v1/mock/login", new ConnectorCall
        {
            Subject = "u_abc",
            Body = new { Subject = "u_abc", CredentialBundle = "cb", Inputs = new Dictionary<string, string> { ["user_name"] = "x" } },
            Ticket = "tkt_1",
            Trigger = "schedule",
            DeviceClass = "web",
            IdempotencyKey = "idem-1",
        }, CancellationToken.None);

        Assert.True(reply.IsSuccess);
        Assert.Equal("ses_1", reply.Text("session_id"));
        var request = Assert.Single(handler.Requests);
        Assert.Equal("dev-key", request.Headers.GetValues(ConnectorAuthSource.DevelopmentHeader).Single());
        Assert.Equal("u_abc", request.Headers.GetValues(ConnectorClient.SubjectHeader).Single());
        Assert.Equal("tkt_1", request.Headers.GetValues(ConnectorClient.TicketHeader).Single());
        Assert.Equal("schedule", request.Headers.GetValues(ConnectorClient.TriggerHeader).Single());
        Assert.Equal("web", request.Headers.GetValues(ConnectorClient.DeviceClassHeader).Single());
        Assert.Equal("idem-1", request.Headers.GetValues(ConnectorClient.IdempotencyHeader).Single());
        Assert.Null(request.Headers.Authorization);
        // snake_case on the wire, dictionary keys as typed
        Assert.Equal("""{"subject":"u_abc","credential_bundle":"cb","inputs":{"user_name":"x"}}""", handler.Bodies.Single());
    }

    [Fact]
    public async Task The_client_reads_the_error_envelope_and_invents_one_for_a_bare_failure()
    {
        var handler = new RecordingHandler(request => request.RequestUri!.AbsolutePath.EndsWith("/gone", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.BadGateway) { Content = new StringContent("<html>bad gateway</html>", Encoding.UTF8, "text/html") }
            : new HttpResponseMessage(HttpStatusCode.TooManyRequests)
            {
                Content = new StringContent(
                    """{"error":{"code":"rate_limited","retriable":true,"user_action":"wait","message_key":"connect.error.rate_limited","retry_after_seconds":120}}""",
                    Encoding.UTF8, "application/json"),
            });
        var client = Client(handler, new ConnectorOptions { BaseUrl = "http://c/", SubjectSalt = "s", DevKey = "k" });

        var limited = await client.GetAsync("v1/mock/receipts", new ConnectorCall { Subject = "u_a" }, CancellationToken.None);
        Assert.False(limited.IsSuccess);
        Assert.Equal("rate_limited", limited.Error!.Code);
        Assert.True(limited.Error.Retriable);
        Assert.Equal("wait", limited.Error.UserAction);
        Assert.Equal(120, limited.Error.RetryAfterSeconds);

        var gone = await client.GetAsync("v1/mock/gone", new ConnectorCall { Subject = "u_a" }, CancellationToken.None);
        Assert.Equal(HttpStatusCode.BadGateway, gone.Status);
        Assert.Equal("provider_unavailable", gone.Error!.Code);
        Assert.True(gone.Error.Retriable);
    }

    [Fact]
    public async Task A_machine_token_is_minted_once_and_reused_until_it_nears_expiry()
    {
        var clock = new TestClock(DateTimeOffset.Parse("2026-09-29T12:00:00Z"));
        var tokens = 0;
        var logto = new RecordingHandler(request =>
        {
            tokens++;
            Assert.Equal("http://logto.test/oidc/token", request.RequestUri!.ToString());
            Assert.Equal("Basic", request.Headers.Authorization!.Scheme);
            var form = request.Content!.ReadAsStringAsync().Result;
            Assert.Contains("grant_type=client_credentials", form, StringComparison.Ordinal);
            Assert.Contains("resource=https%3A%2F%2Fconnector.test", form, StringComparison.Ordinal);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent($$"""{"access_token":"tok-{{tokens}}","expires_in":600}""", Encoding.UTF8, "application/json"),
            };
        });
        var connector = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") });
        var options = new ConnectorOptions
        {
            BaseUrl = "http://c/", SubjectSalt = "s", M2mAppId = "app", M2mAppSecret = "secret", Audience = "https://connector.test",
        };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Auth:Authority"] = "http://logto.test/oidc" }).Build();
        var auth = new ConnectorAuthSource(options, new SingleClientFactory(logto), config, clock);
        var client = new ConnectorClient(new HttpClient(connector) { BaseAddress = new Uri("http://c/") }, auth);

        await client.GetAsync("v1/providers", new ConnectorCall(), CancellationToken.None);
        await client.GetAsync("v1/providers", new ConnectorCall(), CancellationToken.None);
        Assert.Equal(1, tokens);
        Assert.All(connector.Requests, r => Assert.Equal("tok-1", r.Headers.Authorization!.Parameter));

        clock.Advance(TimeSpan.FromMinutes(9.5)); // inside the last minute of a ten-minute token
        await client.GetAsync("v1/providers", new ConnectorCall(), CancellationToken.None);
        Assert.Equal(2, tokens);
        Assert.Equal("tok-2", connector.Requests[^1].Headers.Authorization!.Parameter);
    }

    [Fact]
    public void The_sync_query_asks_for_the_window_and_the_includes_a_resource_offers()
    {
        var manifest = (JsonObject)JsonNode.Parse("""{"limits":{"max_history_days":400}}""")!;
        var receipts = (JsonObject)JsonNode.Parse("""
            {"id":"receipts","returns":"receipt","max_history_days":90,
             "params":[{"key":"since","type":"date","required":true},{"key":"until","type":"date"},
                       {"key":"include","type":"enum","values":["items","invoice","raw"],"multi":true}]}
            """)!;
        var accounts = (JsonObject)JsonNode.Parse("""{"id":"accounts","returns":"account","params":[]}""")!;

        Assert.Equal("?since=2026-06-01&include=items%2Cinvoice", ConnectorSyncService.QueryFor(receipts, manifest, "2026-06-01"));
        Assert.Equal(string.Empty, ConnectorSyncService.QueryFor(accounts, manifest, "2026-06-01"));

        var defaulted = ConnectorSyncService.QueryFor(receipts, manifest, null);
        var since = DateOnly.Parse(Uri.UnescapeDataString(defaulted["?since=".Length..defaulted.IndexOf('&')]));
        Assert.InRange((DateOnly.FromDateTime(DateTime.UtcNow).DayNumber - since.DayNumber), 89, 91);
    }

    [Fact]
    public void Types_are_mapped_the_way_the_app_names_them()
    {
        Assert.Equal("checking", ConnectorIngest.AccountTypeOf("current"));
        Assert.Equal("savings", ConnectorIngest.AccountTypeOf("savings"));
        Assert.Equal("credit", ConnectorIngest.AccountTypeOf("credit_card"));
        Assert.Equal("loan", ConnectorIngest.AccountTypeOf("loan"));
        Assert.Equal("checking", ConnectorIngest.AccountTypeOf("unknown"));

        Assert.Equal("loan", ConnectorIngest.LiabilityTypeOf("instalment"));
        Assert.Equal("credit", ConnectorIngest.LiabilityTypeOf("revolving"));
        Assert.Equal("credit", ConnectorIngest.LiabilityTypeOf("deferred_payment"));
        Assert.Equal("mortgage", ConnectorIngest.LiabilityTypeOf("mortgage"));
        Assert.Equal("loan", ConnectorIngest.LiabilityTypeOf("lease"));
        Assert.Equal("loan", ConnectorIngest.LiabilityTypeOf(null));
    }

    [Fact]
    public void The_compose_command_quotes_the_name_for_the_shell()
    {
        var command = ConnectorRelayEndpoints.ComposeCommand("https://api.munni.test/connector/", "enr_abc", "Okkes' laptop");
        Assert.StartsWith("CONNECTOR_URL=https://api.munni.test/connector/ ENROLLMENT_CODE=enr_abc AGENT_NAME='Okkes'\\'' laptop' docker compose", command, StringComparison.Ordinal);
    }

    private static ConnectorClient Client(HttpMessageHandler handler, ConnectorOptions options)
    {
        var config = new ConfigurationBuilder().Build();
        var auth = new ConnectorAuthSource(options, new SingleClientFactory(handler), config, TimeProvider.System);
        return new ConnectorClient(new HttpClient(handler) { BaseAddress = options.BaseAddress() }, auth);
    }

    /// <summary>Answers every request from a function and keeps what it saw.</summary>
    internal sealed class RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        public List<string> Bodies { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            if (request.Content is not null) Bodies.Add(await request.Content.ReadAsStringAsync(cancellationToken));
            return answer(request);
        }
    }

    internal sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    /// <summary>A clock a test moves by hand.</summary>
    internal sealed class TestClock(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
