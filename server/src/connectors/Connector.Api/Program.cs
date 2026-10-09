using System.Globalization;
using BankConnector.Adapters;
using Connector.Kit.Hosting;
using Sentry;
using Sentry.AspNetCore;
using RegistryConnector.Adapters;
using ShopConnector.Adapters;

var builder = WebApplication.CreateBuilder(args);

// Crash reports to GlitchTip (2026-10-05): every unhandled failure and every
// LogError — an adapter that threw, a party whose site changed, a
// reconciliation that failed. Typed refusals a person can act on (sign in
// again, wait, start your agent) stay Information/Warning and never report.
// An empty DSN (local, tests) disables the SDK entirely.
builder.WebHost.UseSentry((SentryAspNetCoreOptions options) =>
{
    options.Dsn = builder.Configuration["Sentry:Dsn"] ?? string.Empty;
    options.SendDefaultPii = false;
    options.CaptureFailedRequests = false;
    // performance tracing (user 2026-10-09, docs/observability.md): the relay's
    // calls as transactions with their database and party spans —
    // Sentry__TracesSampleRate (0..1, a fifth by default, 0 = errors only);
    // docker's health probe and the agents' heartbeats never count, and a
    // trace the api continued from the web app keeps its decision. No trace
    // header leaves this process: a party's site is nobody's tracing peer.
    var tracesSampleRate = TracesSampleRate(builder.Configuration["Sentry:TracesSampleRate"]);
    options.TracesSampler = context => SampleTrace(context.TransactionContext, tracesSampleRate);
    options.TracePropagationTargets.Clear();
    options.Release = builder.Configuration["BUILD_NUMBER"] is { Length: > 0 } tag ? $"munni-connector@{tag}" : null;
    options.SetBeforeSend((e, _) => { e.SetTag("role", "control-plane"); return e; });
});

// The one control plane of a munni environment hosts every provider pack —
// banks, shops and registries — under one catalogue, one database and one
// consumer credential. Provider ids are unique across the packs, so the
// routes and the catalogue keep their shape; each manifest carries its own
// kind and the consumer groups by it.
//
// Every unconfirmed provider fact — endpoints, client ids, login selectors,
// money units — hangs off these three sections, so correcting one after a
// provider moves is a deploy-time edit rather than a release. The same
// sections bind on the agent, which is where a selector actually gets used.
var banks = builder.Configuration.GetSection("BankAdapters").Get<BankAdapterOptions>()
            ?? new BankAdapterOptions();
var shops = builder.Configuration.GetSection("ShopAdapters").Get<ShopAdapterOptions>()
            ?? new ShopAdapterOptions();
var registries = builder.Configuration.GetSection("RegistryAdapters").Get<RegistryAdapterOptions>()
                 ?? new RegistryAdapterOptions();

builder.Services.AddConnectorPlatform(builder.Configuration, platform =>
{
    // The image stamps its tag here, so an operator reading a catalogue
    // response can tell which build answered the call.
    if (builder.Configuration["BUILD_NUMBER"] is { Length: > 0 } build) platform.ServiceVersion = build;

    // The whole fleet, mocks included. The catalogue is the only contract the
    // consumer codes against, and a provider missing from it cannot be
    // connected at all — not even through an agent that could serve it. The
    // inline runner filters itself down to `agent.required: false` providers,
    // so registering a browser tier here never means this process leasing
    // work it has no browser for.
    foreach (var adapter in BankAdapters.All(banks)) platform.AddAdapter(adapter);
    foreach (var adapter in ShopAdapters.All(shops)) platform.AddAdapter(adapter);
    foreach (var adapter in RegistryAdapters.All(registries)) platform.AddAdapter(adapter);
});

var app = builder.Build();

app.UseConnectorPlatform();
app.MapConnectorReference();
app.MapConnectorApi();
app.MapAgentApi();

await app.RunAsync();

// a number in 0..1, else the platform default of a fifth
static double TracesSampleRate(string? configured) =>
    double.TryParse(configured, NumberStyles.Float, CultureInfo.InvariantCulture, out var rate) && rate is >= 0 and <= 1 ? rate : 0.2;

// /v1/health (docker every 10 s), the operator's /health and the agents' /heartbeat are never a transaction
static double SampleTrace(ITransactionContext context, double rate)
{
    if (rate <= 0 || context.Name.Contains("/health", StringComparison.OrdinalIgnoreCase) || context.Name.Contains("/heartbeat", StringComparison.OrdinalIgnoreCase)) return 0;
    if (context.IsParentSampled is { } parentSampled) return parentSampled ? 1 : 0;
    return rate;
}
