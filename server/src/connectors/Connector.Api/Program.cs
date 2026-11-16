using BankConnector.Adapters;
using Connector.Api;
using Connector.Kit.Hosting;
using Sentry;
using Sentry.AspNetCore;
using RegistryConnector.Adapters;
using ShopConnector.Adapters;

var builder = WebApplication.CreateBuilder(args);

// crash reports to GlitchTip: unhandled failures and every LogError; typed refusals a person can act on stay
// Information/Warning and never report. An empty DSN (local, tests) disables the SDK
builder.WebHost.UseSentry((SentryAspNetCoreOptions options) =>
{
    options.Dsn = builder.Configuration["Sentry:Dsn"] ?? string.Empty;
    options.SendDefaultPii = false;
    options.CaptureFailedRequests = false;
    // health probes and agent heartbeats are never traced, and no trace header leaves this process (a party's site is no peer)
    var tracesSampleRate = ConnectorTracing.SampleRate(builder.Configuration["Sentry:TracesSampleRate"]);
    options.TracesSampler = context => ConnectorTracing.Sample(context.TransactionContext, tracesSampleRate);
    options.TracePropagationTargets.Clear();
    options.Release = builder.Configuration["BUILD_NUMBER"] is { Length: > 0 } tag ? $"munni-connector@{tag}" : null;
    options.SetBeforeSend((e, _) => ConnectorNoise.Quiet(e));
});

// one control plane per environment hosts every provider pack under one catalogue, database and consumer credential;
// provider ids are unique across packs. Unconfirmed provider facts hang off these sections so a correction is a
// deploy-time edit
var banks = builder.Configuration.GetSection("BankAdapters").Get<BankAdapterOptions>()
            ?? new BankAdapterOptions();
var shops = builder.Configuration.GetSection("ShopAdapters").Get<ShopAdapterOptions>()
            ?? new ShopAdapterOptions();
var registries = builder.Configuration.GetSection("RegistryAdapters").Get<RegistryAdapterOptions>()
                 ?? new RegistryAdapterOptions();

builder.Services.AddConnectorPlatform(builder.Configuration, platform =>
{
    // the image stamps its tag so an operator can tell which build answered a catalogue call
    if (builder.Configuration["BUILD_NUMBER"] is { Length: > 0 } build) platform.ServiceVersion = build;

    // the whole fleet, mocks included: a provider missing from the catalogue (the consumer's only contract) cannot be
    // connected, not even through an agent; the inline runner filters itself to agent.required:false providers, so it
    // never leases browser work
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
