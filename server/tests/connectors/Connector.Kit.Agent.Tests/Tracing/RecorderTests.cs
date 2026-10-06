using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Tracing;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Tests.Tracing;

/// <summary>
/// The recorder on a real browser (#441 L3): a run that asked to be recorded
/// posts what the page did - navigations, calls with their answers, the
/// console, the jar - with the secrets taken out; a run that did not ask
/// posts nothing; a run that failed posts its trace all the same.
/// </summary>
public sealed class RecorderTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(90);

    private const string LoginPage =
        "<html><head><title>login</title></head><body><form><input name=\"password\" type=\"password\"></form>" +
        "<script>" +
        "fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'shopper',password:'hunter2'})})" +
        ".then(r=>r.json()).then(()=>{console.error('a line with hunter2 in it');document.title='done';});" +
        "</script></body></html>";

    private static ScriptedAdapter Browses(bool thenFails = false) => new(async (ctx, ct) =>
    {
        var page = await ctx.Browser.PageAsync(ct);

        await page.Context.AddCookiesAsync(
        [
            new Cookie { Name = "sid", Value = "secret-cookie-value", Domain = "provider.test", Path = "/", HttpOnly = true, Secure = true },
        ]);

        await page.RouteAsync("**/*", route =>
        {
            if (route.Request.Url.EndsWith("/api/session", StringComparison.Ordinal))
            {
                return route.FulfillAsync(new RouteFulfillOptions
                {
                    ContentType = "application/json",
                    Headers = new Dictionary<string, string> { ["x-session-token"] = "tok_12345" },
                    Body = "{\"ok\":true,\"access_token\":\"tok_12345\",\"orders\":[{\"id\":\"o1\"}]}",
                });
            }

            return route.FulfillAsync(new RouteFulfillOptions { ContentType = "text/html", Body = LoginPage });
        });

        await page.GotoAsync("https://provider.test/login");
        await page.WaitForFunctionAsync("() => document.title === 'done'");

        if (thenFails) throw ConnectorException.Blocked("the fixture stops here");
    });

    private static LeasedJob Recorded() => TestRig.Login(budgetSeconds: 60) with { Record = true };

    [Fact]
    public async Task A_recorded_run_posts_what_the_browser_did_with_the_secrets_taken_out()
    {
        using var rig = new TestRig(Browses());

        await rig.RunAsync(Recorded()).WaitAsync(Patience);

        Assert.NotNull(rig.Control.Result);
        var trace = rig.Control.Trace;
        Assert.NotNull(trace);

        Assert.Contains(trace.Entries, e => e.Kind == TraceKind.Navigation && e.Url == "https://provider.test/login");

        var document = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Response && e.ResourceType == "document");
        Assert.Equal(200, document.Status);
        Assert.Contains("<title>login</title>", document.Body, StringComparison.Ordinal);

        var call = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Request && e.Url == "https://provider.test/api/session");
        Assert.Equal("POST", call.Method);
        Assert.Contains("\"username\":\"shopper\"", call.Body, StringComparison.Ordinal);
        Assert.Contains(call.Headers, h => h.Name.Equals("cookie", StringComparison.OrdinalIgnoreCase) && h.Value.StartsWith("sid=«redacted", StringComparison.Ordinal));

        var answer = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Response && e.Url == "https://provider.test/api/session");
        Assert.Contains("\"ok\":true", answer.Body, StringComparison.Ordinal);
        Assert.Contains("\"orders\"", answer.Body, StringComparison.Ordinal);
        Assert.Contains(answer.Headers, h => h.Name.Equals("x-session-token", StringComparison.OrdinalIgnoreCase) && h.Value == "«redacted:9»");

        Assert.Contains(trace.Entries, e => e.Kind == TraceKind.Console && e.Level == "error");
        Assert.Contains(trace.Entries, e => e.Kind == TraceKind.Dom && e.Text is { Length: > 0 });

        var jar = Assert.Single(trace.Cookies);
        Assert.Equal("sid", jar.Name);
        Assert.Equal("secret-cookie-value".Length, jar.ValueLength);
        Assert.True(jar.HttpOnly);

        var everything = System.Text.Json.JsonSerializer.Serialize(trace, ConnectorWireJson.Options);
        Assert.DoesNotContain("hunter2", everything, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-cookie-value", everything, StringComparison.Ordinal);
        Assert.DoesNotContain("tok_12345", everything, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_run_that_did_not_ask_posts_no_trace()
    {
        using var rig = new TestRig(Browses());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 60)).WaitAsync(Patience);

        Assert.NotNull(rig.Control.Result);
        Assert.Equal(0, rig.Control.TraceCount);
    }

    [Fact]
    public async Task A_failing_recorded_run_posts_its_trace_before_its_failure()
    {
        using var rig = new TestRig(Browses(thenFails: true));

        await rig.RunAsync(Recorded()).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(ErrorCode.BlockedByProvider), rig.Control.FailureCode);
        Assert.Null(rig.Control.Result);
        Assert.NotNull(rig.Control.Trace);
        Assert.Contains(rig.Control.Trace!.Entries, e => e.Kind == TraceKind.Navigation);
        Assert.Contains(rig.Control.Trace!.Entries, e => e.Kind == TraceKind.Note && e.Text == "the run ended");
    }

    [Fact]
    public async Task A_recorded_run_that_never_opened_a_browser_still_posts_its_notes()
    {
        using var rig = new TestRig(new DecidedAdapter());

        await rig.RunAsync(Recorded()).WaitAsync(Patience);

        var trace = rig.Control.Trace;
        Assert.NotNull(trace);
        Assert.Empty(trace.Cookies);
        Assert.All(trace.Entries, e => Assert.Equal(TraceKind.Note, e.Kind));
    }
}
