using BankConnector.Adapters;
using Connector.Kit.Hosting;
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
    options.TracesSampleRate = 0;
    options.SendDefaultPii = false;
    options.CaptureFailedRequests = false;
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
