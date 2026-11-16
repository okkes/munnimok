using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Asn;

/// Discovery run: types and clicks nothing; the human signs in through the live view while it records each distinct screen.
/// PageShape keeps selectors, roles, counts and dimensions, never page text or digits.
internal sealed class AsnDiscoveryAdapter(AsnOptions? options = null, TimeProvider? time = null) : IProviderAdapter
{
    public const string ProviderId = "asn-discovery";

    private readonly AsnOptions _options = options ?? new AsnOptions();
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public ProviderManifest Manifest { get; } = AsnDiscoveryManifest.Build();

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        await page.GotoAsync(_options.LoginUrl).ConfigureAwait(false);

        ctx.Note(
            $"{ProviderId}: this run types nothing and clicks nothing. Sign in yourself in the view above - "
            + "it writes down what each screen is made of, and none of what it says.");

        ctx.Progress(JobStep.AwaitingHuman);

        // raised, not awaited: a live view is a conversation; cancelling the linked source ends it
        using var view = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var asked = ctx.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                PromptKey = AsnDiscoveryManifest.LiveKey,
                ExpiresAt = _time.GetUtcNow().AddSeconds(_options.DiscoverySeconds),
            },
            view.Token);

        try
        {
            await WatchAsync(ctx, page, ct).ConfigureAwait(false);
        }
        finally
        {
            // end the relay whatever happened, so the agent is released rather than held on an open bank session
            await view.CancelAsync().ConfigureAwait(false);

            _ = asked.ContinueWith(static t => t.Exception, TaskScheduler.Default);
        }

        // not a connection: a bundle would leave a usable ASN session sealed on a device under a provider that cannot fetch
        throw ConnectorException.Unsupported(
            $"{ProviderId}: this was a discovery run, not a connection. Read the notes above, put the "
            + "selectors into AsnOptions, and connect with the real adapter once it has them");
    }

    /// Records each distinct screen once: a sign-in redraws constantly and a note per sample would bury the screens that matter.
    private async Task WatchAsync(IJobContext ctx, IPage page, CancellationToken ct)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deadline = _time.GetUtcNow().AddSeconds(_options.DiscoverySeconds);

        // judged over the whole run: the sign-in page renders tabs and method buttons before any form, so sample one has no input
        var typed = false;
        var quiet = false;
        var lastNew = _time.GetUtcNow();

        while (_time.GetUtcNow() < deadline && seen.Count < _options.DiscoveryScreens)
        {
            ct.ThrowIfCancellationRequested();

            if (await DescribeAsync(page, ct).ConfigureAwait(false) is { } described
                && seen.Add(described))
            {
                ctx.Note($"{ProviderId}: screen {seen.Count} - {described}");

                typed |= described.Contains("inputs:", StringComparison.Ordinal);
                lastNew = _time.GetUtcNow();
            }

            // nothing new for a while means done: a live view has no "done" button, so the run would hold the browser
            // for its full window; only once something was seen, since nothing recorded yet means the page is still arriving
            if (seen.Count > 0
                && _time.GetUtcNow() - lastNew >= TimeSpan.FromSeconds(_options.QuietSeconds))
            {
                quiet = true;
                break;
            }

            await Task.Delay(TimeSpan.FromSeconds(_options.SamplePollSeconds), _time, ct).ConfigureAwait(false);
        }

        if (seen.Count == 0)
        {
            ctx.Note(
                $"{ProviderId}: no screen could be described at all, which usually means the page never "
                + "loaded. Nothing here is worth writing into AsnOptions");

            return;
        }

        ctx.Note(
            $"{ProviderId}: {seen.Count} distinct screen(s) recorded"
            + (quiet ? $", and nothing new for {_options.QuietSeconds}s, so this finished by itself" : string.Empty)
            + ". Read them in order: the sign-in form, the QR, the first page inside, and the statement "
            + "download");

        if (!typed)
        {
            ctx.Note(
                $"{ProviderId}: not one screen in this run had an input on it, so the sign-in form was never "
                + $"reached. Check AsnOptions.LoginUrl - it is currently {_options.LoginUrl}");
        }
    }

    private static async Task<string?> DescribeAsync(IPage page, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        try
        {
            return PageShape.Describe(await page.EvaluateAsync<JsonElement>(PageShape.Script).ConfigureAwait(false));
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // a page mid-navigation cannot be evaluated; skipped, the next sample is seconds away
            return null;
        }
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        throw ConnectorException.Unsupported(
            $"{ProviderId}: a discovery run reads nothing. It exists to describe ASN's pages once, so the "
            + "real adapter can be written against them");
}
