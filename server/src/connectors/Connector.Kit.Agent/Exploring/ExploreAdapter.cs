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

// explore run (#441 L3): the recording happens around this adapter (job context, record flag); this only drives
// the live view is raised in windows of WindowMinutes: "more" opens the next; an unanswered window ends the run as a success
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
            // not fatal: the operator has a URL bar, and what did not load is worth seeing
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
                // nobody said done, or the window could not even open: the operator walked away and what they recorded stands
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
