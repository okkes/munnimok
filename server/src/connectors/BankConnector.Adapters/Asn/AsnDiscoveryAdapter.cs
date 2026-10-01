using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Asn;

/// <summary>
/// The session that turns ASN from a sketch into an adapter.
///
/// <para>
/// <b>This types nothing and clicks nothing.</b> Every other adapter here drives
/// a provider; this one opens the front door, streams the page to whoever asked
/// for it, and gets out of the way. The account holder signs in themselves -
/// in their own browser's view of the agent's browser, with their own phone -
/// and while they work, this writes down what each screen is MADE of.
/// </para>
///
/// <para>
/// It works that way because the alternative does not. A discovery run that
/// drove the form would have to guess the selectors, and guessing the selectors
/// is the entire thing being discovered; a wrong guess would spend one of a
/// small number of sign-in attempts and teach nobody anything.
/// </para>
///
/// <para>
/// <b>Nothing gates the human.</b> The first version of this asked them to press
/// continue at four points, which was wrong twice over: it made them do
/// bookkeeping while holding a phone, and it could only ever record the four
/// screens somebody had thought of in advance. Sampling instead records every
/// DISTINCT screen the session passes through, including the ones nobody
/// predicted - which on an unknown bank is most of the value.
/// </para>
///
/// <para>
/// What comes out is a list of selectors, in notes, which somebody reads and
/// pastes into <see cref="AsnOptions"/>. Nothing here writes that file and
/// nothing here decides anything: a human reads "inputs: text #serienummer
/// autocomplete=username" and makes the call.
/// </para>
///
/// <para>
/// What it must never carry out of somebody's bank is <see cref="PageShape"/>'s
/// job - selectors, roles, counts and dimensions, and no text but headings and
/// complaints. A QR is located by being a square of a couple of hundred pixels,
/// never by its bytes; a number on screen is reported as its length, never as
/// its digits.
/// </para>
/// </summary>
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

        // NOT AWAITED, which is the whole shape of a live view: the challenge
        // is a conversation rather than a question, so it is raised and left
        // running while this watches. Cancelling the linked source is what ends
        // it - see DuoAdapter, where the same pattern watches for a login to
        // land rather than for a clock to run out.
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
            // Ends the relay whatever happened, so an agent is released rather
            // than held on somebody's open bank session.
            await view.CancelAsync().ConfigureAwait(false);

            // Observed rather than awaited: it was cancelled on purpose, and
            // the cancellation it throws is not news.
            _ = asked.ContinueWith(static t => t.Exception, TaskScheduler.Default);
        }

        // NOT A CONNECTION. A discovery run has learned things and authenticated
        // nothing this platform should keep - handing back a bundle would leave
        // a usable ASN session sealed on somebody's device under a provider that
        // cannot fetch.
        throw ConnectorException.Unsupported(
            $"{ProviderId}: this was a discovery run, not a connection. Read the notes above, put the "
            + "selectors into AsnOptions, and connect with the real adapter once it has them");
    }

    /// <summary>
    /// Samples the page while the human works, and keeps each screen once.
    /// </summary>
    /// <remarks>
    /// DISTINCT SHAPES, NOT A TIMELINE. A bank's sign-in redraws constantly -
    /// a spinner, a countdown, a field gaining focus - and a note per sample
    /// would bury the four screens that matter under two hundred that do not.
    /// So a screen is recorded the first time its description appears and never
    /// again, which also means the natural end of the run is "nothing new for a
    /// while".
    /// </remarks>
    private async Task WatchAsync(IJobContext ctx, IPage page, CancellationToken ct)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deadline = _time.GetUtcNow().AddSeconds(_options.DiscoverySeconds);

        // Whether ANY screen ever offered somewhere to type.
        //
        // Judged over the whole run rather than on the first screen, which is
        // what the first version did and immediately got wrong: ASN's sign-in
        // page renders its bank tabs before its method buttons and its method
        // buttons before any form, so the first sample of a perfectly good
        // login page has no input on it. The warning fired on a page that was
        // simply still arriving.
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

            // NOTHING NEW FOR A WHILE MEANS SOMEBODY HAS FINISHED.
            //
            // A live view is passive - there is no button for "I am done" - so
            // without this the run holds the browser for its full twelve
            // minutes after the last screen, with nothing on the caller's
            // screen and no way to end it. A person who downloaded their
            // statement and closed the tab was left watching a progress trail.
            //
            // Only once something HAS been seen: a run that has recorded
            // nothing is a run whose page is still arriving, and cutting that
            // short would end the session before it began.
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

        // Said at the END, once the whole run has been seen. A sign-in that
        // never offered anywhere to type is a run that never reached a sign-in
        // page, and the address is the first thing to doubt.
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
            // A page mid-navigation cannot be evaluated, and mid-navigation is
            // most of what a login does. Skipped rather than reported: the next
            // sample is a second or two away, and a note per failed probe would
            // be a note per navigation.
            return null;
        }
    }

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        throw ConnectorException.Unsupported(
            $"{ProviderId}: a discovery run reads nothing. It exists to describe ASN's pages once, so the "
            + "real adapter can be written against them");
}
