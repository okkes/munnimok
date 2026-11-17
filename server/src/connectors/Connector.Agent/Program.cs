using System.Globalization;
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

// crash reports to GlitchTip (the environment's connector project, shared with the control plane): an adapter that threw
// reaches it as the scrubbed LogError; a login the person has to redo never does. An empty DSN disables the SDK
builder.Logging.AddSentry(options =>
{
    options.Dsn = builder.Configuration["Sentry:Dsn"] ?? string.Empty;
    options.SendDefaultPii = false;
    // a 5xx of the control plane is retried by the host's own loops, which report what did not land in the end
    options.CaptureFailedRequests = false;
    // a generic host starts no transaction, so the rate only governs a job transaction's spans; only the control plane may
    // receive trace headers, never a shop's or a bank's site
    options.TracesSampleRate =
        double.TryParse(builder.Configuration["Sentry:TracesSampleRate"], NumberStyles.Float, CultureInfo.InvariantCulture, out var rate) && rate is >= 0 and <= 1
            ? rate
            : 0.2;
    options.TracePropagationTargets.Clear();
    foreach (var controlPlane in builder.Configuration.GetSection("ConnectorAgent:Connections").GetChildren()
                 .Select(connection => connection["ControlPlaneBaseUrl"])
                 .Where(url => !string.IsNullOrWhiteSpace(url)))
    {
        options.TracePropagationTargets.Add(controlPlane!);
    }
    options.MinimumEventLevel = LogLevel.Error;
    options.MinimumBreadcrumbLevel = LogLevel.Information;
    options.Release = builder.Configuration["BUILD_NUMBER"] is { Length: > 0 } tag ? $"munni-connector-agent@{tag}" : null;
    options.SetBeforeSend((e, _) => { e.SetTag("role", "agent"); return e; });
});

// the same sections the control planes bind: an agent is where a selector is used,
// so a correction on an API alone applies nowhere that matters
var banks = builder.Configuration.GetSection("BankAdapters").Get<BankAdapterOptions>()
            ?? new BankAdapterOptions();
var shops = builder.Configuration.GetSection("ShopAdapters").Get<ShopAdapterOptions>()
            ?? new ShopAdapterOptions();
var registries = builder.Configuration.GetSection("RegistryAdapters").Get<RegistryAdapterOptions>()
                 ?? new RegistryAdapterOptions();

builder.Services.AddConnectorAgent(builder.Configuration, agent =>
{
    // every adapter is advertised to every connector this agent serves: a lease takes the connector's own catalogue
    // filtered by capabilities.CanServe (EfLeasedJobQueue.TryLeaseAsync), so unknown ids are harmless; per-connector
    // lists would make this image know which provider belongs to which product
    foreach (var adapter in BankAdapters.All(banks)) agent.AddAdapter(adapter);
    foreach (var adapter in ShopAdapters.All(shops)) agent.AddAdapter(adapter);
    foreach (var adapter in RegistryAdapters.All(registries)) agent.AddAdapter(adapter);
});

// drain window plus abort grace must fit the host's shutdown timeout (default 30s), or a dropped login leaves a browser open
// on a half-submitted form; one window per process suffices: MaxConcurrency jobs run in total, not per connector
builder.Services.Configure<HostOptions>(host => host.ShutdownTimeout = TimeSpan.FromSeconds(45));

await builder.Build().RunAsync();
