using Connector.Kit.Agent.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Tests;

// Playwright paints each mask in a top-layer x-pw-glass popover, so the mask of a password field under a captcha
// overlay blacked out the question (seen on an Albert Heijn hCaptcha). The way out: conceal the element ourselves
// and drop only the mask for what we concealed; reverting ConcealAsync fails the first test
public sealed class RedactionOverlayTests : IAsyncLifetime
{
    /// <summary>Distinctive on purpose: any pixel of it proves the overlay was photographed.</summary>
    private const string OverlayColour = "#008080";

    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        _playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions { Headless = true });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null) await _browser.CloseAsync();
        _playwright?.Dispose();
    }

    /// compared with the same page without the field: no mask means identical pixels; both are absolutely positioned
    /// so the concealed input, which keeps its box so nothing reflows, cannot move the overlay
    [Fact]
    public async Task An_overlay_covering_a_password_field_is_photographed_intact()
    {
        var crop = new CropRegion(40, 40, 260, 120);

        var withField = await CaptureAsync(Markup(withPassword: true), crop);
        var withoutField = await CaptureAsync(Markup(withPassword: false), crop);

        Assert.NotEmpty(withField);
        Assert.NotEmpty(withoutField);

        // byte-equal: a mask would paint a solid black rectangle across one of them
        Assert.Equal(withoutField, withField);
    }

    [Fact]
    public async Task A_page_still_holding_a_secret_is_refused()
    {
        var page = await NewPageAsync(Markup(withPassword: true, value: "hunter2"));
        var redactor = new ScreenshotRedactor(ManifestWithSecret(), NullLogger.Instance);

        Assert.False(await redactor.IsSafeToCaptureAsync(page, CancellationToken.None));
        Assert.Empty(await redactor.CaptureAsync(page, null, CancellationToken.None));
    }

    /// an adapter goes on to type into this form: a field left invisible would strand the login with no error to explain it
    [Fact]
    public async Task The_field_is_visible_again_afterwards()
    {
        var page = await NewPageAsync(Markup(withPassword: true));
        var redactor = new ScreenshotRedactor(ManifestWithSecret(), NullLogger.Instance);

        await redactor.CaptureAsync(page, new CropRegion(40, 40, 260, 120), CancellationToken.None);

        var visibility = await page.EvaluateAsync<string>(
            "() => getComputedStyle(document.querySelector('#password')).visibility");
        var marker = await page.EvaluateAsync<bool>(
            "() => document.querySelector('#password').hasAttribute('data-connector-vis')");

        Assert.Equal("visible", visibility);
        Assert.False(marker);
    }

    private async Task<byte[]> CaptureAsync(string html, CropRegion crop)
    {
        var page = await NewPageAsync(html);
        var redactor = new ScreenshotRedactor(ManifestWithSecret(), NullLogger.Instance);
        return await redactor.CaptureAsync(page, crop, CancellationToken.None);
    }

    private async Task<IPage> NewPageAsync(string html)
    {
        var context = await _browser!.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = new ViewportSize { Width = 400, Height = 300 },
            DeviceScaleFactor = 1,
        });

        var page = await context.NewPageAsync();
        await page.SetContentAsync(html);
        return page;
    }

    /// the shape of every login a provider fronts with a captcha
    private static string Markup(bool withPassword, string value = "")
    {
        var field = withPassword
            ? "<input id='password' type='password' autocomplete='current-password' value='" + value + "' "
              + "style='position:absolute;left:60px;top:70px;width:200px;height:40px' />"
            : string.Empty;

        return "<!doctype html><html><body style='margin:0;background:#ffffff'>"
            + field
            + "<div style='position:absolute;left:40px;top:40px;width:260px;height:120px;background:"
            + OverlayColour + ";color:#ffffff;font:16px sans-serif'>Klik op de kortste lijn</div>"
            + "</body></html>";
    }

    /// the shared rig's manifest already declares a secret keyed password;
    /// reused so this cannot drift from the other agent tests
    private static ProviderManifest ManifestWithSecret() => TestRig.Manifest;
}
