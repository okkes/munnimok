using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

/// <summary>
/// A browser that is only launched if an adapter actually asks for one.
///
/// The laziness is not an optimisation. A T1 adapter runs on an agent that has
/// browser binaries installed, and starting Chromium for a run that makes six
/// HTTP calls would burn seconds and hundreds of megabytes per job for
/// nothing. <see cref="Started"/> is also what the job runner keys artifact
/// capture off, so a pure-HTTP failure never tries to photograph a page that
/// does not exist.
/// </summary>
public sealed class BrowserLease : IChallengeSurface
{
    /// <summary>A valid, empty Playwright storage state.</summary>
    private const string EmptyStorageState = "{\"cookies\":[],\"origins\":[]}";

    /// <summary>
    /// How long measuring an element may take. Short on purpose: the element
    /// is one the caller has already found, so this is a re-measure and not a
    /// search, and a challenge that is not on screen now will not be in ten
    /// seconds either.
    /// </summary>
    private const float MeasureTimeoutMs = 5_000;

    private readonly BrowserLeaseOptions _options;
    private readonly ScreenshotRedactor _redactor;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly SemaphoreSlim _launchLock = new(1, 1);

    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private IBrowserContext? _context;
    private IPage? _page;
    private int _disposed;

    public BrowserLease(
        BrowserLeaseOptions options, ScreenshotRedactor redactor, ILogger logger, TimeProvider? time = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(redactor);
        ArgumentNullException.ThrowIfNull(logger);

        _options = options;
        _redactor = redactor;
        _logger = logger;
        _time = time ?? TimeProvider.System;
    }

    public bool Started => Volatile.Read(ref _page) is not null;

    /// <summary>True when this lease is driving a persistent profile (T4).</summary>
    public bool IsPersistent => _options.ProfileDirectory is not null;

    public async Task<IPage> PageAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _page) is { } existing) return existing;

        await _launchLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) == 1, this);
            if (_page is not null) return _page;

            _playwright = await Playwright.CreateAsync().ConfigureAwait(false);
            _context = _options.ProfileDirectory is { } profile
                ? await LaunchPersistentAsync(_playwright, profile).ConfigureAwait(false)
                : await LaunchEphemeralAsync(_playwright).ConfigureAwait(false);

            _context.SetDefaultTimeout(_options.OperationTimeoutMs);
            _context.SetDefaultNavigationTimeout(_options.NavigationTimeoutMs);

            if (!_options.HasAuthenticator) await RefuseWebAuthnAsync(_context).ConfigureAwait(false);

            // A persistent context opens with a page already; an ephemeral one
            // does not.
            var page = _context.Pages.Count > 0
                ? _context.Pages[0]
                : await _context.NewPageAsync().ConfigureAwait(false);

            if (_options.OnPage is { } opened)
            {
                try
                {
                    await opened(page).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "the page hook failed; the page is handed out unrecorded");
                }
            }

            Volatile.Write(ref _page, page);
            return page;
        }
        finally
        {
            _launchLock.Release();
        }
    }

    /// <summary>
    /// The cookies and local storage to seal into the bundle - the cheap 80%
    /// win of session reuse.
    ///
    /// Returns an empty state when the provider's custody is the AGENT'S,
    /// deliberately. For a T4 provider the bundle is only
    /// <c>{agent_id, profile_id}</c> and carries no secret at all; exporting
    /// the profile's cookies here would put the credential this design keeps in
    /// the user's house on the wire.
    /// <para>
    /// KEYED ON CUSTODY RATHER THAN ON PERSISTENCE, and those were the same
    /// thing right up until a BYO agent started running ordinary providers in a
    /// persistent browser. Inferring it from the profile would seal an empty
    /// bundle for every client-custody provider: fine while the machine is on,
    /// and then the fleet picks up a session with no cookies in it and asks for
    /// a sign-in nobody can explain.
    /// </para>
    /// </summary>
    public async Task<string> StorageStateAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (_options.KeepsCookiesHere)
        {
            _logger.LogWarning(
                "storage state was requested for an agent-custody session and refused; " +
                "these cookies must stay on this machine");
            return EmptyStorageState;
        }

        if (_context is null) return EmptyStorageState;

        return await _context.StorageStateAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// A redacted screenshot, or an empty array when the page cannot be
    /// verified safe. See <see cref="ScreenshotRedactor"/>.
    /// </summary>
    public async Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct)
    {
        var page = Volatile.Read(ref _page);
        if (page is null) return [];

        return await _redactor.CaptureAsync(page, crop, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Photographs exactly this box and hands back the box with the picture.
    ///
    /// The same redactor governs, unchanged: it refuses to photograph a page
    /// that still holds a secret, and a captcha is not an exception to that. It
    /// is why the Albert Heijn password is cleared out of the DOM before any
    /// capture - the fix for a refusal is to stop holding the secret, never to
    /// soften the refusal. A refusal arrives here as no bytes and becomes
    /// <see cref="RegionCapture.Refused"/>: no image, and therefore nothing a
    /// tap could later be measured against.
    /// </summary>
    public async Task<RegionCapture> CaptureRegionAsync(CropRegion region, CancellationToken ct)
    {
        var page = Volatile.Read(ref _page);
        if (page is null) return RegionCapture.Refused;

        return await ClipAsync(page, region, "the requested box", ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Photographs exactly this element - found, scrolled into view, measured,
    /// and clipped to what it occupies.
    /// </summary>
    public async Task<RegionCapture> CaptureElementAsync(string selector, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(selector);

        var page = Volatile.Read(ref _page);
        if (page is null) return RegionCapture.Refused;

        var element = page.Locator(selector);

        CropRegion? box;
        try
        {
            await element.ScrollIntoViewIfNeededAsync(
                new LocatorScrollIntoViewIfNeededOptions { Timeout = MeasureTimeoutMs }).ConfigureAwait(false);

            var measured = await element.BoundingBoxAsync(
                new LocatorBoundingBoxOptions { Timeout = MeasureTimeoutMs }).ConfigureAwait(false);

            box = measured is null ? null : RegionCapture.Enclosing(measured.X, measured.Y, measured.Width, measured.Height);
        }
        catch (Exception ex) when (IsMeasureMiss(ex))
        {
            _logger.LogWarning(ex, "no capture: '{Selector}' could not be measured", selector);
            return RegionCapture.Refused;
        }

        return await ClipAsync(page, box, $"'{selector}'", ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Photographs exactly this frame, through the <c>&lt;iframe&gt;</c>
    /// element that hosts it.
    ///
    /// The case the whole feature exists for. A cross-origin captcha frame can
    /// be found by its URL among <c>page.Frames</c> when no selector of ours
    /// names the element around it, and its contents cannot be reached at all -
    /// so the frame is photographed from the outside, as a box on the page.
    /// </summary>
    public async Task<RegionCapture> CaptureFrameAsync(IFrame frame, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(frame);

        var page = Volatile.Read(ref _page);
        if (page is null) return RegionCapture.Refused;

        CropRegion? box;
        try
        {
            var host = await frame.FrameElementAsync().ConfigureAwait(false);
            await host.ScrollIntoViewIfNeededAsync(
                new ElementHandleScrollIntoViewIfNeededOptions { Timeout = MeasureTimeoutMs }).ConfigureAwait(false);

            var measured = await host.BoundingBoxAsync().ConfigureAwait(false);
            box = measured is null ? null : RegionCapture.Enclosing(measured.X, measured.Y, measured.Width, measured.Height);
        }
        catch (Exception ex) when (IsMeasureMiss(ex))
        {
            // A frame that detached while we were measuring it is the normal
            // way a captcha ends - including the way it ends when the human
            // has already passed it.
            _logger.LogWarning(ex, "no capture: the frame {Url} could not be measured", Describe(frame));
            return RegionCapture.Refused;
        }

        return await ClipAsync(page, box, $"the frame {Describe(frame)}", ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Clicks where the human tapped, in their order, and reports how many
    /// clicks were dispatched.
    ///
    /// Zero means nothing was clicked, which is what every refusal returns -
    /// including a lease with no browser at all. See
    /// <see cref="TapReplay.ReplayAsync"/> for the rest of the rules.
    /// </summary>
    public async Task<int> ReplayTapsAsync(IReadOnlyList<Tap> taps, RegionCapture capture, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(taps);

        var page = Volatile.Read(ref _page);
        if (page is null) return 0;

        // Null when the context runs at the window's own size - a headed agent,
        // typically. There is then no viewport to check the box against, and
        // inventing one would refuse taps that are perfectly reachable.
        var viewport = page.ViewportSize is { } size ? (size.Width, size.Height) : ((int, int)?)null;

        return await TapReplay.ReplayAsync(
            taps,
            capture,
            viewport,
            new MousePointer(page.Mouse, _time),
            _options.TapGap,
            _logger,
            ct).ConfigureAwait(false);
    }

    /// <summary>The page's shape as a hash, for a failure artifact.</summary>
    public async Task<string?> DomDigestAsync(CancellationToken ct)
    {
        var page = Volatile.Read(ref _page);
        if (page is null) return null;

        return await _redactor.DomDigestAsync(page, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The one place a region capture happens, so the box that is clipped is
    /// necessarily the box that comes back - which is the entire basis of the
    /// coordinate mapping, and not a property worth re-deriving per overload.
    /// Anything the redactor declines becomes <see cref="RegionCapture.Refused"/>
    /// rather than an empty picture.
    /// </summary>
    private async Task<RegionCapture> ClipAsync(IPage page, CropRegion? box, string what, CancellationToken ct)
    {
        if (box is not { } region)
        {
            _logger.LogWarning("no capture: {What} occupies nothing photographable", what);
            return RegionCapture.Refused;
        }

        var png = await _redactor.CaptureAsync(page, region, ct).ConfigureAwait(false);
        if (png.Length == 0) return RegionCapture.Refused;

        return RegionCapture.Of(png, region);
    }

    /// <summary>
    /// "That element is not there", whatever Playwright chose to call it.
    ///
    /// Playwright for .NET raises <see cref="TimeoutException"/> - NOT a
    /// <see cref="PlaywrightException"/> - when a wait expires, so catching
    /// only the latter lets a challenge that simply moved take the whole login
    /// down instead of returning no image.
    /// </summary>
    private static bool IsMeasureMiss(Exception ex) => ex is PlaywrightException or TimeoutException;

    private static string Describe(IFrame frame) => string.IsNullOrEmpty(frame.Url) ? "<about:blank>" : frame.Url;

    private async Task<IBrowserContext> LaunchPersistentAsync(IPlaywright playwright, string profileDirectory)
    {
        Directory.CreateDirectory(profileDirectory);

        if (_options.StorageState is not null)
        {
            // The profile IS the state. Layering a bundle's storage state on
            // top would resurrect a session the profile has since replaced.
            _logger.LogDebug("ignoring the bundle's storage state: this lease drives a persistent profile");
        }

        var launch = new BrowserTypeLaunchPersistentContextOptions
        {
            Headless = _options.Headless,
            Args = _options.Args.Count > 0 ? _options.Args : null,
            AcceptDownloads = true,
            DownloadsPath = _options.DownloadsPath,
            Locale = _options.Locale,
            TimezoneId = _options.TimezoneId,

            // The machine's own browser, when it has been named one. Null here
            // is Playwright's bundled Chromium, which is what a container has.
            Channel = _options.Channel,
        };

        if (Device(playwright) is { } device)
        {
            launch.UserAgent = device.UserAgent;
            launch.ViewportSize = device.ViewportSize;
            launch.DeviceScaleFactor = device.DeviceScaleFactor;
            launch.IsMobile = device.IsMobile;
            launch.HasTouch = device.HasTouch;
        }

        _logger.LogInformation("launching a persistent browser profile at {Directory}", profileDirectory);
        var context = await playwright.Chromium
            .LaunchPersistentContextAsync(profileDirectory, launch)
            .ConfigureAwait(false);

        await OfferTheKeptSessionAsync(context, profileDirectory).ConfigureAwait(false);

        return context;
    }

    /// <summary>
    /// Puts back the session cookies the last browser on this profile closed
    /// holding, before anything navigates.
    /// </summary>
    /// <remarks>
    /// HERE RATHER THAN IN <see cref="PageAsync"/>, because a persistent
    /// context opens holding a blank page and the adapter's first
    /// <c>GotoAsync</c> is the request that decides whether this job is signed
    /// in. A cookie added after it is a cookie the only request that mattered
    /// went without.
    /// <para>
    /// See <see cref="KeptSessionStore"/> for why a persistent profile does not
    /// carry its own session, why only an agent on somebody's own machine does
    /// this, and why putting a cookie back is an offer rather than a claim.
    /// </para>
    /// </remarks>
    private async Task OfferTheKeptSessionAsync(IBrowserContext context, string profileDirectory)
    {
        if (!_options.KeepsSessionAcrossBrowsers) return;

        var kept = new KeptSessionStore(profileDirectory, _logger, _options.DropsKeptSessionFor)
            .Restore(_options.KeptSessionLifetime, _time.GetUtcNow());

        if (kept.Count == 0) return;

        try
        {
            await context.AddCookiesAsync(kept).ConfigureAwait(false);
            _logger.LogInformation(
                "put {Count} kept session cookie(s) back into this profile's browser", kept.Count);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // A restore that does not take is a sign-in, never a failed job.
            // Chromium refuses a whole batch over one cookie it dislikes - a
            // SameSite=None that is not Secure, a domain it will not accept -
            // and the adapter is about to ask the provider whether this browser
            // is signed in regardless. That question is the one that decides.
            //
            // THE PREDICATE RATHER THAN THE TYPE, because Playwright for .NET
            // raises a TimeoutException and not a PlaywrightException when a
            // call of its own expires - so catching the Playwright type alone
            // would let exactly the likeliest failure through, and a job whose
            // browser could not be handed its old cookies would die as
            // `internal` instead of starting signed out. SelectorMissRuleTests
            // sweeps the whole repository for that mistake; this is the shape
            // it asks for.
            _logger.LogWarning(ex, "the kept session could not be put back; this job starts signed out");
        }
    }

    /// <summary>
    /// Hands this profile's session cookies to the store before the browser
    /// that holds them closes.
    /// </summary>
    /// <remarks>
    /// BEFORE <see cref="IBrowserContext.CloseAsync"/> and not after, for the
    /// obvious reason: a closed context has no cookies left to ask it for. It
    /// is also the last moment they exist anywhere - Chromium's own profile
    /// database keeps them but will not load them again.
    /// </remarks>
    private async Task KeepTheSessionAsync()
    {
        if (!_options.KeepsSessionAcrossBrowsers) return;
        if (_options.ProfileDirectory is not { } profile) return;
        if (_context is not { } context) return;

        var cookies = await context.CookiesAsync().ConfigureAwait(false);
        new KeptSessionStore(profile, _logger, _options.DropsKeptSessionFor).Keep(cookies, _time.GetUtcNow());
    }

    /// <summary>
    /// Tells a page that this browser has no authenticator, because it does
    /// not.
    ///
    /// A pooled agent is a container. It has no security key, no fingerprint
    /// reader, no phone and nobody sitting at it. Leaving the WebAuthn API in
    /// place does not make a passkey possible there; it makes the page WAIT for
    /// one - and Amazon's sign-in asks with <c>mediation: "required"</c> and a
    /// fifteen-minute timeout, which in a headed container is a browser dialog
    /// nothing can ever answer. Every live Amazon login died exactly there: the
    /// password accepted, the page frozen, the same DOM digest three runs
    /// running, and a four-minute budget spent on a browser waiting for
    /// hardware that does not exist.
    ///
    /// This is the opposite of the fingerprint games the rest of this class
    /// refuses. It does not pretend to be a browser it is not - it stops
    /// pretending to be one it is not. A site that offers a password because
    /// the client cannot do passkeys has been told the truth, and the user
    /// asked for the password path when they typed one in.
    ///
    /// Not applied to a BYO agent: that browser runs on somebody's own machine,
    /// where the authenticator is real and using it is their business.
    /// </summary>
    private static Task<IAsyncDisposable> RefuseWebAuthnAsync(IBrowserContext context) =>
        context.AddInitScriptAsync(@"
() => {
  try {
    delete window.PublicKeyCredential;
    if (navigator.credentials) {
      const refuse = () => Promise.reject(
        new DOMException('this browser has no authenticator', 'NotAllowedError'));
      Object.defineProperty(navigator, 'credentials', {
        configurable: true,
        get: () => ({ get: refuse, create: refuse, preventSilentAccess: () => Promise.resolve() }),
      });
    }
  } catch (e) {
  }
}");

    private async Task<IBrowserContext> LaunchEphemeralAsync(IPlaywright playwright)
    {
        _browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = _options.Headless,
            Args = _options.Args.Count > 0 ? _options.Args : null,
            DownloadsPath = _options.DownloadsPath,
        }).ConfigureAwait(false);

        var context = Device(playwright) is { } device
            ? new BrowserNewContextOptions(device)
            : new BrowserNewContextOptions();

        context.AcceptDownloads = true;
        context.StorageState = _options.StorageState;
        if (_options.Locale is not null) context.Locale = _options.Locale;
        if (_options.TimezoneId is not null) context.TimezoneId = _options.TimezoneId;

        _logger.LogInformation(
            "launching a browser (session reuse: {Reuse})", _options.StorageState is null ? "no" : "yes");

        return await _browser.NewContextAsync(context).ConfigureAwait(false);
    }

    /// <summary>
    /// An honest device descriptor, or null for plain desktop Chromium.
    ///
    /// These are real strings from real browsers on real hardware, chosen when
    /// a provider serves a different site to a phone - not a disguise. Nothing
    /// else about the fingerprint is touched: no <c>navigator.webdriver</c>
    /// patching, no canvas noise, no stealth plugin. Crossing that line costs
    /// the whole quarantine argument in front of anyone who asks.
    /// </summary>
    private BrowserNewContextOptions? Device(IPlaywright playwright)
    {
        if (_options.DeviceName is not { } name) return null;

        if (playwright.Devices.TryGetValue(name, out var device)) return device;

        _logger.LogWarning("unknown playwright device '{Device}'; falling back to desktop chromium", name);
        return null;
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;

        // Teardown never throws over a job's real outcome: a browser that
        // failed to close cleanly must not turn a successful fetch into a
        // failure, nor mask the exception that is already on its way up. The
        // same applies to the session: a profile that could not keep one is a
        // sign-in next run, not a failed job now.
        await Quietly(KeepTheSessionAsync, "keeping this profile's session").ConfigureAwait(false);

        await Quietly(async () =>
        {
            if (_context is not null) await _context.CloseAsync().ConfigureAwait(false);
        }, "closing the browser context").ConfigureAwait(false);

        await Quietly(async () =>
        {
            if (_browser is not null) await _browser.CloseAsync().ConfigureAwait(false);
        }, "closing the browser").ConfigureAwait(false);

        try
        {
            _playwright?.Dispose();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "disposing playwright failed");
        }

        _launchLock.Dispose();
        Volatile.Write(ref _page, null);
    }

    private async Task Quietly(Func<Task> action, string what)
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "{What} failed", what);
        }
    }
}

/// <summary>
/// Everything the job runner knows about how this job's browser should be
/// shaped. Built per job, never shared.
/// </summary>
public sealed record BrowserLeaseOptions
{
    public bool Headless { get; init; } = true;

    /// <summary>
    /// Whether this browser can actually reach an authenticator.
    ///
    /// False for a pooled agent, which is the honest answer: a container has no
    /// security key, no fingerprint reader and no phone. True only where the
    /// browser runs on somebody's own machine - see
    /// <see cref="BrowserLease.RefuseWebAuthnAsync"/> for what leaving it false
    /// prevents, and why it is the opposite of a disguise.
    /// </summary>
    public bool HasAuthenticator { get; init; }

    /// <summary>
    /// Which agents may claim one. Only a BYO agent: its browser runs on
    /// somebody's own machine, where the authenticator is real and using it is
    /// their business. Every other class is a machine in a datacenter.
    /// </summary>
    public static bool CanReachAuthenticator(AgentClass agent) => agent == AgentClass.Byo;

    /// <summary>A storage state from the session material. Null on a first login.</summary>
    public string? StorageState { get; init; }

    /// <summary>The profile directory this job must drive, when it has one.</summary>
    public string? ProfileDirectory { get; init; }

    /// <summary>
    /// A browser the machine already has, by Playwright's channel name -
    /// <c>chrome</c>, <c>msedge</c>. Null for the Chromium Playwright ships.
    /// </summary>
    /// <remarks>
    /// FOR AN AGENT ON SOMEBODY'S OWN MACHINE, which is a different kind of
    /// place from a container. A pooled agent gets the bundled Chromium
    /// because that is all there is and because every pooled run should look
    /// alike. A BYO agent is a person's computer: the browser they have is the
    /// browser their bank has seen before, and driving a different one - a
    /// build no consumer ships, with no history - is the version of that
    /// machine most likely to be asked for a second factor.
    /// <para>
    /// It also removes a download. The bundled Chromium is about 150 MB that a
    /// user installing an agent has no use for when Chrome is already there.
    /// </para>
    /// </remarks>
    public string? Channel { get; init; }

    /// <summary>
    /// Whether this browser's cookies must never leave the machine.
    /// </summary>
    /// <remarks>
    /// TRUE FOR AGENT CUSTODY AND NOTHING ELSE, and the distinction was worth
    /// the field. This used to be inferred from "is the profile persistent",
    /// which was the same thing while only T4 providers had profiles - and
    /// stopped being the same thing the moment a BYO agent started running
    /// ordinary providers in a persistent browser.
    /// <para>
    /// Inferring it there would have sealed an EMPTY bundle for every provider
    /// whose custody is the client's: the connection would look fine until the
    /// machine went offline, and the fleet would then pick up a session with no
    /// cookies in it and ask the user to sign in again for no reason anybody
    /// could see.
    /// </para>
    /// </remarks>
    public bool KeepsCookiesHere { get; init; }

    /// <summary>
    /// Whether the session cookies this browser makes outlive it.
    /// </summary>
    /// <remarks>
    /// TRUE ONLY ON SOMEBODY'S OWN MACHINE, and the job runner sets it from the
    /// same question it answers everything else about a BYO agent with. A
    /// pooled agent must never do this: its profiles are wiped between jobs by
    /// design, and a datacenter container that resurrected a bank session after
    /// the browser closed would be the opposite of what the pooled tier
    /// promises.
    /// <para>
    /// A different question from <see cref="KeepsCookiesHere"/>, although both
    /// are about cookies and a refusal. That one is CUSTODY - whether these
    /// cookies may be sealed into a bundle and sent to the connector. This one
    /// is about a file on the disk they were made on, which crosses nothing.
    /// See <see cref="KeptSessionStore"/>.
    /// </para>
    /// </remarks>
    public bool KeepsSessionAcrossBrowsers { get; init; }

    /// <summary>
    /// How long a kept session is worth offering back. See
    /// <see cref="ConnectorAgentOptions.KeptSessionLifetime"/> for the
    /// judgment; zero or less turns the carry off entirely.
    /// </summary>
    public TimeSpan KeptSessionLifetime { get; init; }

    /// <summary>
    /// Hosts this provider says are not worth keeping a session for, straight
    /// off <see cref="Manifests.AuthSpec.DropsKeptSessionFor"/>.
    /// </summary>
    /// <remarks>
    /// EMPTY IS EVERY PROVIDER THAT SAYS NOTHING, and keeps the whole session.
    /// The lease does not interpret these - it carries them to
    /// <see cref="KeptSessionStore"/>, which is where the matching rule and the
    /// measurement behind it live. Nothing in this assembly could interpret
    /// them: <c>login.digid.nl</c> is an identity provider to a manifest and a
    /// hostname to a browser.
    /// </remarks>
    public IReadOnlyList<string> DropsKeptSessionFor { get; init; } = [];

    /// <summary>An honest Playwright device descriptor name, e.g. <c>Pixel 5</c>.</summary>
    public string? DeviceName { get; init; }

    /// <summary>
    /// The per-job work directory. Downloads land here so a statement a
    /// provider hands us is deleted with the job rather than left on disk.
    /// </summary>
    public string? DownloadsPath { get; init; }

    public string? Locale { get; init; }

    public string? TimezoneId { get; init; }

    /// <summary>
    /// The gap between two replayed taps. See <see cref="TapReplay.DefaultGap"/>
    /// for why there is one at all.
    /// </summary>
    public TimeSpan TapGap { get; init; } = TapReplay.DefaultGap;

    public float NavigationTimeoutMs { get; init; } = 45_000;

    public float OperationTimeoutMs { get; init; } = 30_000;

    public IReadOnlyList<string> Args { get; init; } = [];

    /// <summary>
    /// Called once, with the page the lease created, before anything has
    /// navigated it (#441 L3): the recorder's door. A hook that throws is
    /// logged and the page is handed out anyway - a recording is never the
    /// reason a login fails.
    /// </summary>
    public Func<IPage, Task>? OnPage { get; init; }
}
