using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

// lazy on purpose: a pure-HTTP T1 run must not start Chromium (seconds, hundreds of MB)
// Started gates failure-artifact capture
public sealed class BrowserLease : IChallengeSurface
{
    private const string EmptyStorageState = "{\"cookies\":[],\"origins\":[]}";

    // short on purpose: a re-measure of an element already found; an absent challenge will not appear in ten seconds
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

    // empty for agent custody on purpose: the bundle is only {agent_id, profile_id}; cookies must not go on the wire
    // keyed on custody, not persistence: a BYO agent runs ordinary providers in a persistent browser,
    // and an empty bundle would make the fleet ask for a sign-in
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

    public async Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct)
    {
        var page = Volatile.Read(ref _page);
        if (page is null) return [];

        return await _redactor.CaptureAsync(page, crop, ct).ConfigureAwait(false);
    }

    // the redactor governs unchanged: a captcha is no exception; fix a refusal by not holding the secret, never by softening
    // a refusal is RegionCapture.Refused: no image, so nothing a tap could be measured against
    public async Task<RegionCapture> CaptureRegionAsync(CropRegion region, CancellationToken ct)
    {
        var page = Volatile.Read(ref _page);
        if (page is null) return RegionCapture.Refused;

        return await ClipAsync(page, region, "the requested box", ct).ConfigureAwait(false);
    }

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

    // photographed from outside, via its iframe element: a cross-origin captcha frame is found by URL, its contents unreachable
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
            // a frame detaching mid-measure is the normal end of a captcha, including after the human passed it
            _logger.LogWarning(ex, "no capture: the frame {Url} could not be measured", Describe(frame));
            return RegionCapture.Refused;
        }

        return await ClipAsync(page, box, $"the frame {Describe(frame)}", ct).ConfigureAwait(false);
    }

    public async Task<int> ReplayTapsAsync(IReadOnlyList<Tap> taps, RegionCapture capture, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(taps);

        var page = Volatile.Read(ref _page);
        if (page is null) return 0;

        // null at the window's own size (a headed agent): no viewport to check, and inventing one would refuse reachable taps
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

    public async Task<string?> DomDigestAsync(CancellationToken ct)
    {
        var page = Volatile.Read(ref _page);
        if (page is null) return null;

        return await _redactor.DomDigestAsync(page, ct).ConfigureAwait(false);
    }

    // the one capture path: the clipped box is necessarily the box returned, which the tap mapping rests on
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

    // Playwright for .NET raises TimeoutException, not PlaywrightException, when a wait expires:
    // a moved challenge must not fail the login
    private static bool IsMeasureMiss(Exception ex) => ex is PlaywrightException or TimeoutException;

    private static string Describe(IFrame frame) => string.IsNullOrEmpty(frame.Url) ? "<about:blank>" : frame.Url;

    private async Task<IBrowserContext> LaunchPersistentAsync(IPlaywright playwright, string profileDirectory)
    {
        Directory.CreateDirectory(profileDirectory);

        if (_options.StorageState is not null)
        {
            // the profile is the state: layering a bundle's storage state would resurrect a session the profile has replaced
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

            // the machine's own browser when named; null is Playwright's bundled Chromium, which a container has
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

    // restored here, not in PageAsync: a persistent context opens on a blank page,
    // and the adapter's first GotoAsync decides whether the job is signed in
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
            // a restore that does not take is a sign-in, never a failed job (Chromium refuses a whole batch over one bad cookie)
            // the predicate, not the type: Playwright for .NET raises TimeoutException on its own expiry (SelectorMissRuleTests)
            _logger.LogWarning(ex, "the kept session could not be put back; this job starts signed out");
        }
    }

    // before CloseAsync: a closed context has no cookies left, and Chromium's profile database will not load them again
    private async Task KeepTheSessionAsync()
    {
        if (!_options.KeepsSessionAcrossBrowsers) return;
        if (_options.ProfileDirectory is not { } profile) return;
        if (_context is not { } context) return;

        var cookies = await context.CookiesAsync().ConfigureAwait(false);
        new KeptSessionStore(profile, _logger, _options.DropsKeptSessionFor).Keep(cookies, _time.GetUtcNow());
    }

    // no authenticator in a pooled agent (a container): leaving WebAuthn makes the page wait for a passkey
    // Amazon's sign-in (mediation required, 15 min) hung every live login; not for a BYO agent, whose authenticator is real
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

    // real device strings for providers that serve phones another site; nothing else is touched
    // (no webdriver patch, canvas noise or stealth plugin)
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

        // teardown never throws over a job's outcome: a failed close, or a session that could not be kept, is a sign-in next run
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

public sealed record BrowserLeaseOptions
{
    public bool Headless { get; init; } = true;

    // true only for a browser on somebody's own machine; false makes RefuseWebAuthnAsync hide the WebAuthn API
    public bool HasAuthenticator { get; init; }

    // only a BYO agent: its browser runs on somebody's own machine; every other class is a datacenter machine
    public static bool CanReachAuthenticator(AgentClass agent) => agent == AgentClass.Byo;

    /// <summary>A storage state from the session material. Null on a first login.</summary>
    public string? StorageState { get; init; }

    public string? ProfileDirectory { get; init; }

    // BYO agent only: the person's own Chrome/Edge is the browser their bank has seen; a bundled build is likelier asked
    // for a second factor; also skips a ~150 MB download
    public string? Channel { get; init; }

    // agent custody only, not "profile is persistent": a BYO agent runs ordinary providers in a persistent browser,
    // and inferring it would seal an empty bundle, so the fleet asks for a sign-in for no visible reason
    public bool KeepsCookiesHere { get; init; }

    // own machine only: a pooled agent's profiles are wiped between jobs and must not resurrect a bank session
    // a file on the disk it was made on, unlike KeepsCookiesHere (custody: what may be sealed and sent)
    public bool KeepsSessionAcrossBrowsers { get; init; }

    // zero or less turns the carry off; see ConnectorAgentOptions.KeptSessionLifetime
    public TimeSpan KeptSessionLifetime { get; init; }

    // from the manifest; empty keeps the whole session. The lease only carries them: the matching rule is in KeptSessionStore
    public IReadOnlyList<string> DropsKeptSessionFor { get; init; } = [];

    public string? DeviceName { get; init; }

    // downloads land in the per-job directory so a provider's statement is deleted with the job
    public string? DownloadsPath { get; init; }

    public string? Locale { get; init; }

    public string? TimezoneId { get; init; }

    public TimeSpan TapGap { get; init; } = TapReplay.DefaultGap;

    public float NavigationTimeoutMs { get; init; } = 45_000;

    public float OperationTimeoutMs { get; init; } = 30_000;

    public IReadOnlyList<string> Args { get; init; } = [];

    // called once with the new page before it navigates (#441 L3): the recorder's door;
    // a throwing hook is logged and the page is handed out anyway
    public Func<IPage, Task>? OnPage { get; init; }
}
