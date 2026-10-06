using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Exploring;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Tracing;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Exploring;

/// <summary>
/// The explore run on the agent (#441 L3): open the browser at the address
/// the operator gave, hand them the live view with navigation allowed, and
/// wait until they say they are done. The recording happens around this
/// adapter, not in it - a job that carries the record flag is recorded
/// from the first byte by the job context - so all this does is drive.
///
/// The live view is raised in windows of <see cref="ExploreProvider.WindowMinutes"/>:
/// an answer of <c>more</c> opens the next one, anything else ends the run.
/// A window nobody answered ends it too, as a success rather than a
/// timeout: the operator walked away, and what they recorded until then is
/// the deliverable.
/// </summary>
public sealed class ExploreAdapter(TimeProvider? time = null) : IProviderAdapter
{
    public const string More = "more";

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public ProviderManifest Describe() => ExploreProvider.Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        if (!ctx.Inputs.TryGetValue(ExploreProvider.UrlField, out var raw) || !ExploreProvider.IsNavigable(raw, out var start))
        {
            throw ConnectorException.InvalidRequest(
                "explore: the start address must be http(s) on a public host, with no user-info");
        }

        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        try
        {
            await page.GotoAsync(start.ToString(), new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            // Not fatal: the operator has a URL bar and can try another
            // address, and what did not load is itself worth seeing.
            ctx.Note($"the start address did not load: {ex.Message}");
        }

        while (!ct.IsCancellationRequested)
        {
            ChallengeAnswer answer;
            try
            {
                answer = await ctx.AskAsync(new Challenge
                {
                    Type = ChallengeType.LiveView,
                    PromptKey = ExploreProvider.PromptKey,
                    ExpiresAt = _time.GetUtcNow().AddMinutes(ExploreProvider.WindowMinutes),
                }, ct).ConfigureAwait(false);
            }
            catch (ConnectorException ex) when (ex.Code is ErrorCode.MfaTimeout or ErrorCode.ChallengeExpired)
            {
                // Nobody said done and the window lapsed - or could not even
                // open. The operator walked away; what they recorded stands.
                ctx.Note("the window closed with nobody at the view; the run ends here");
                break;
            }

            if (!string.Equals(answer.Value?.Trim(), More, StringComparison.OrdinalIgnoreCase)) break;

            ctx.Note("another window opened");
        }

        ct.ThrowIfCancellationRequested();
        ctx.Note($"explored up to {TraceRedaction.Url(page.Url)}");

        var state = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);
        return new LoginResult
        {
            Material = new SessionMaterial { StorageState = state },
            Account = new ProviderAccount { DisplayName = start.Host },
        };
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        throw ConnectorException.Unsupported("an explore run has nothing to fetch; read its recording instead");
}
