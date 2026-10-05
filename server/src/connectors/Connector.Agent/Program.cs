using BankConnector.Adapters;
using Connector.Kit.Agent;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Sentry;
using RegistryConnector.Adapters;
using ShopConnector.Adapters;

var builder = Host.CreateApplicationBuilder(args);

// Crash reports to GlitchTip (2026-10-05), the environment's connector
// project shared with the control plane: an adapter that threw reaches it
// as the scrubbed LogError the runner already writes; a login the person
// has to redo never does. An empty DSN disables the SDK.
builder.Logging.AddSentry(options =>
{
    options.Dsn = builder.Configuration["Sentry:Dsn"] ?? string.Empty;
    options.SendDefaultPii = false;
    options.TracesSampleRate = 0;
    options.MinimumEventLevel = LogLevel.Error;
    options.MinimumBreadcrumbLevel = LogLevel.Information;
    options.Release = builder.Configuration["BUILD_NUMBER"] is { Length: > 0 } tag ? $"munni-connector-agent@{tag}" : null;
    options.SetBeforeSend((e, _) => { e.SetTag("role", "agent"); return e; });
});

// The same sections the three control planes bind. They have to be here as
// well: an agent is where a selector actually gets used, so an unconfirmed
// value corrected on an API alone would be corrected nowhere that matters.
var banks = builder.Configuration.GetSection("BankAdapters").Get<BankAdapterOptions>()
            ?? new BankAdapterOptions();
var shops = builder.Configuration.GetSection("ShopAdapters").Get<ShopAdapterOptions>()
            ?? new ShopAdapterOptions();
var registries = builder.Configuration.GetSection("RegistryAdapters").Get<RegistryAdapterOptions>()
                 ?? new RegistryAdapterOptions();

builder.Services.AddConnectorAgent(builder.Configuration, agent =>
{
    // EVERY ADAPTER THIS PLATFORM HAS, ADVERTISED TO EVERY CONNECTOR THIS
    // AGENT ATTACHES TO - and that is safe rather than sloppy.
    //
    // What an agent may lease is ITS connector's own catalogue filtered by
    // what the agent says it can serve: EfLeasedJobQueue.TryLeaseAsync takes
    // registry.Manifests and keeps the ones capabilities.CanServe. So the
    // bank connector matches asn, ing and the bank mocks out of this list and
    // has never heard of duo or jumbo; nothing anywhere validates the ids it
    // does not know. The alternative - telling each connector only its own
    // third - would mean this image knowing which provider belongs to which
    // product, which is exactly the split the household should not have to
    // care about.
    foreach (var adapter in BankAdapters.All(banks)) agent.AddAdapter(adapter);
    foreach (var adapter in ShopAdapters.All(shops)) agent.AddAdapter(adapter);
    foreach (var adapter in RegistryAdapters.All(registries)) agent.AddAdapter(adapter);
});

// The drain window plus the abort grace must fit inside the host's own
// shutdown timeout, which defaults to 30s and would otherwise stop waiting
// first. A dropped login is a browser left open on a provider with a
// half-submitted form and a session nothing will unstick until a TTL notices.
//
// One window for the process, and it is enough for several connectors: the
// machine runs MaxConcurrency jobs in total, not that many per connector, so
// the number of browsers to drain does not grow with the connection list.
builder.Services.Configure<HostOptions>(host => host.ShutdownTimeout = TimeSpan.FromSeconds(45));

await builder.Build().RunAsync();
