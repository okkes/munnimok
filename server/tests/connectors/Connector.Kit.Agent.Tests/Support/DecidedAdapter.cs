using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// An adapter whose every answer is decided by the test: what a fetch
/// returns, which error a login refuses with, whether a logout breaks, and
/// whether a login parks until its token is cancelled.
/// </summary>
internal sealed class DecidedAdapter : IProviderAdapter
{
    public static readonly SessionMaterial Material = new() { AccessToken = "at_1", StorageState = "{}" };

    public FetchResult Fetch { get; init; } = FetchResult.Empty;

    public ErrorCode? Refuses { get; init; }

    public bool LogoutThrows { get; init; }

    public bool Parks { get; init; }

    public TaskCompletionSource Parked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public ResourceRequest? Requested { get; private set; }

    public bool LoggedOut { get; private set; }

    public ProviderManifest Describe() => TestRig.Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        if (Refuses is { } code) throw new ConnectorException(code, "scripted refusal");

        if (Parks)
        {
            Parked.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, ct).ConfigureAwait(false);
        }

        return new LoginResult
        {
            Material = Material,
            Account = new ProviderAccount { DisplayName = "Test Account" },
        };
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        Requested = request;
        return Task.FromResult(Fetch);
    }

    public Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        LoggedOut = true;
        return LogoutThrows ? throw new InvalidOperationException("the provider hung up") : Task.CompletedTask;
    }
}
