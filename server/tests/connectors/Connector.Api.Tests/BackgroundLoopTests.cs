using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Manifests;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Connector.Api.Tests;

/// <summary>
/// A call that times out reports an OperationCanceledException nobody asked
/// for. A loop that reads it as the host's stop ends for good - quietly in a
/// sweep, and with the whole process in the pump, whose exception leaves the
/// BackgroundService. Only the stopping token says the host is stopping.
/// </summary>
public class BackgroundLoopTests
{
    /// <summary>Every scope "times out"; the second request for one proves the loop came back.</summary>
    private sealed class TimingOutScopes : IServiceScopeFactory
    {
        private readonly TaskCompletionSource _twice = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _asked;

        public Task AskedTwice => _twice.Task;

        public IServiceScope CreateScope()
        {
            if (Interlocked.Increment(ref _asked) >= 2) _twice.TrySetResult();
            throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout of 10 seconds elapsing.");
        }
    }

    private sealed class OneProviderRunner : IInlineJobRunner
    {
        public IReadOnlyList<string> Providers { get; } = ["mock"];

        public AgentCapabilities Capabilities { get; } = new();

        public bool CanRun(ProviderManifest manifest) => true;

        public void Dispatch()
        {
            // the pump under test polls by itself
        }

        public Task RunAsync(LeasedJob job, CancellationToken ct) => Task.CompletedTask;
    }

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task The_expiry_sweep_comes_back_after_a_call_that_timed_out()
    {
        var scopes = new TimingOutScopes();
        var options = Options.Create(new ConnectorOptions());
        options.Value.Timeouts.ExpirySweepSeconds = 1;
        using var sweeps = new ExpiryService(scopes, null!, null!, null!, options, TimeProvider.System, NullLogger<ExpiryService>.Instance);

        await sweeps.StartAsync(CancellationToken.None);
        await scopes.AskedTwice.WaitAsync(Patience);
        await sweeps.StopAsync(CancellationToken.None);

        Assert.True(scopes.AskedTwice.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task The_inline_pump_comes_back_after_a_call_that_timed_out()
    {
        var scopes = new TimingOutScopes();
        using var pump = new InlineJobPump(
            new OneProviderRunner(), scopes, new ConnectorSignals(), Options.Create(new ConnectorOptions()), NullLogger<InlineJobPump>.Instance);

        await pump.StartAsync(CancellationToken.None);
        await scopes.AskedTwice.WaitAsync(Patience);
        await pump.StopAsync(CancellationToken.None);

        Assert.True(scopes.AskedTwice.IsCompletedSuccessfully);
    }
}
