using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

// an hCaptcha grid sits in a cross-origin iframe no selector reaches: the picture goes to the human, taps return
// as fractions, and page.Mouse (browser-level) dispatches them inside it
// separate from IBrowserLease until moved there with defaults: ShopConnector.Adapters references Connector.Kit only
public interface IChallengeSurface : IBrowserLease
{
    Task<RegionCapture> CaptureRegionAsync(CropRegion region, CancellationToken ct);

    Task<RegionCapture> CaptureElementAsync(string selector, CancellationToken ct);

    // a cross-origin captcha frame is reachable as an IFrame by URL long before a selector can name its element
    Task<RegionCapture> CaptureFrameAsync(IFrame frame, CancellationToken ct);

    // zero means nothing was clicked, never a partial replay: every refusal is decided before the first click
    // TapAnswer.Submit is not this method's business: which control means verify is provider knowledge
    Task<int> ReplayTapsAsync(IReadOnlyList<Tap> taps, RegionCapture capture, CancellationToken ct);
}
