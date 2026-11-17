using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

// last step before an image leaves the machine: refuse while a secret or password field holds content, mask, clip
// anything it cannot verify yields NO image (empty), never an error
public sealed class ScreenshotRedactor
{
    private const float CaptureTimeoutMs = 10_000;

    // walks shadow roots: modern login forms sit in them and querySelectorAll does not pierce them
    private const string SecretProbeScript = @"
(keys) => {
  const roots = [document];
  const walk = (root, depth) => {
    if (depth > 8 || roots.length > 500) return;
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
    }
  };
  walk(document, 0);

  const filled = (el) => {
    const v = (el.value !== undefined && el.value !== null) ? el.value : el.getAttribute('value');
    return typeof v === 'string' && v.length > 0;
  };

  const dirty = [];
  const scan = (selector, label) => {
    for (const root of roots) {
      let els;
      try { els = root.querySelectorAll(selector); } catch (e) { continue; }
      for (const el of els) { if (filled(el)) { dirty.push(label); return; } }
    }
  };

  scan('input[type=password]', 'password-input');
  scan('input[autocomplete*=password i]', 'password-autocomplete');
  for (const probe of keys) { scan(probe[1], probe[0]); }
  return dirty;
}";

    // visibility:hidden, never display:none: it keeps the box, so no reflow shifts the widget the crop was measured against
    // returns how many elements would not hide; above zero the caller falls back to masking
    private const string ConcealScript = @"
(keys) => {
  const roots = [document];
  const walk = (root, depth) => {
    if (depth > 8 || roots.length > 500) return;
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
    }
  };
  walk(document, 0);

  let missed = 0;
  const conceal = (selector) => {
    for (const root of roots) {
      let els;
      try { els = root.querySelectorAll(selector); } catch (e) { continue; }
      for (const el of els) {
        try {
          if (!el.hasAttribute('data-connector-vis')) {
            el.setAttribute('data-connector-vis', el.style.visibility || '');
          }
          el.style.setProperty('visibility', 'hidden', 'important');
          if (getComputedStyle(el).visibility !== 'hidden') missed++;
        } catch (e) { missed++; }
      }
    }
  };

  conceal('input[type=password]');
  conceal('input[autocomplete*=password i]');
  for (const probe of keys) { conceal(probe[1]); }
  return missed;
}";

    // re-check after the shutter: a mid-capture re-render could restore styling and let a value through, so drop the bytes
    private const string ConcealedProbeScript = @"
(keys) => {
  const roots = [document];
  const walk = (root, depth) => {
    if (depth > 8 || roots.length > 500) return;
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
    }
  };
  walk(document, 0);

  const bad = [];
  const check = (selector, label) => {
    for (const root of roots) {
      let els;
      try { els = root.querySelectorAll(selector); } catch (e) { continue; }
      for (const el of els) {
        let shown = true;
        try { shown = getComputedStyle(el).visibility !== 'hidden'; } catch (e) { shown = true; }
        const v = (el.value !== undefined && el.value !== null) ? el.value : el.getAttribute('value');
        const filled = typeof v === 'string' && v.length > 0;
        if (shown || filled) { bad.push(label); return; }
      }
    }
  };

  check('input[type=password]', 'password-input');
  check('input[autocomplete*=password i]', 'password-autocomplete');
  for (const probe of keys) { check(probe[1], probe[0]); }
  return bad;
}";

    private const string RevealScript = @"
() => {
  const roots = [document];
  const walk = (root, depth) => {
    if (depth > 8 || roots.length > 500) return;
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
    }
  };
  walk(document, 0);

  for (const root of roots) {
    let els;
    try { els = root.querySelectorAll('[data-connector-vis]'); } catch (e) { continue; }
    for (const el of els) {
      try {
        const previous = el.getAttribute('data-connector-vis') || '';
        el.style.removeProperty('visibility');
        if (previous) el.style.visibility = previous;
        el.removeAttribute('data-connector-vis');
      } catch (e) { /* leaving one hidden is safe; showing it again is not */ }
    }
  }
}";

    // only the hash leaves the agent; no text or attribute values, so an account number cannot change the digest
    private const string SkeletonScript = @"
() => {
  const parts = [];
  const walk = (node, depth) => {
    if (depth > 24 || parts.length > 4000) return;
    for (const el of node.children) {
      let tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'button') tag += ':' + (el.getAttribute('type') || '');
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
      const role = el.getAttribute('role') || '';
      parts.push(depth + '|' + tag + '|' + testId + '|' + role);
      walk(el, depth + 1);
    }
  };
  walk(document.documentElement, 0);
  return parts.join('\n');
}";

    // masked on every page, whatever the manifest declares
    private static readonly string[] PasswordInputSelectors =
    [
        "input[type=password]",
        "input[autocomplete*=password i]",
    ];

    private readonly ILogger _logger;

    // [key, selector] pairs as plain arrays: independent of how Playwright serialises object properties
    private readonly string[][] _probes;

    private readonly string _maskSelector;

    public ScreenshotRedactor(ProviderManifest manifest, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(logger);

        _logger = logger;
        _probes =
        [
            .. manifest.Auth.AllFields()
                .Where(f => f.Secret)
                .DistinctBy(f => f.Key, StringComparer.Ordinal)
                .Select(f => new[] { f.Key, SelectorFor(f) }),
        ];

        _maskSelector = string.Join(", ", PasswordInputSelectors.Concat(_probes.Select(p => p[1])));
    }

    // also run before an adapter-supplied image is posted: the adapter holds a real IPage and could produce bytes by any route
    public async Task<bool> IsSafeToCaptureAsync(IPage page, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);
        ct.ThrowIfCancellationRequested();

        if (page.IsClosed)
        {
            _logger.LogDebug("no capture: the page is closed");
            return false;
        }

        foreach (var frame in page.Frames)
        {
            ct.ThrowIfCancellationRequested();

            string[] dirty;
            try
            {
                dirty = await frame.EvaluateAsync<string[]>(SecretProbeScript, _probes).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // A frame we cannot read is a frame we cannot vouch for, and a
                // maybe-safe image is worth strictly less than no image.
                _logger.LogWarning(ex, "no capture: frame {Url} could not be inspected", Describe(frame));
                return false;
            }

            if (dirty.Length > 0)
            {
                // The field KEYS are manifest metadata, never values.
                _logger.LogInformation(
                    "no capture: {Fields} still hold content", string.Join(", ", dirty.Distinct(StringComparer.Ordinal)));
                return false;
            }
        }

        return true;
    }

    // empty means "no image", never an error
    public async Task<byte[]> CaptureAsync(IPage page, CropRegion? crop, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);

        if (!await IsSafeToCaptureAsync(page, ct).ConfigureAwait(false)) return [];

        if (crop is { } size && (size.Width <= 0 || size.Height <= 0))
        {
            _logger.LogWarning("no capture: crop region {W}x{H} is empty", size.Width, size.Height);
            return [];
        }

        // conceal rather than mask when the page lets us: a mask is painted into the top layer, so over an overlay
        // (AH hCaptcha) it hides the challenge; elementFromPoint cannot license dropping a mask; masking stays the fallback
        var concealed = await ConcealAsync(page, ct).ConfigureAwait(false);

        try
        {
            var options = new PageScreenshotOptions
            {
                Type = ScreenshotType.Png,
                Animations = ScreenshotAnimations.Disabled,
                Caret = ScreenshotCaret.Hide,
                MaskColor = "#000000",
                Timeout = CaptureTimeoutMs,
            };

            if (!concealed) options.Mask = MaskLocators(page);

            if (crop is { } region)
            {
                options.Clip = new Clip
                {
                    X = region.X,
                    Y = region.Y,
                    Width = region.Width,
                    Height = region.Height,
                };
            }

            byte[] png;
            try
            {
                png = await page.ScreenshotAsync(options).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // Deliberately no retry without the masks: the fallback that
                // drops a safety layer is worse than no image.
                _logger.LogWarning(ex, "no capture: the screenshot itself failed");
                return [];
            }

            // the shutter and the checks are not one instant: a mid-capture re-render could fill a field, so discard the bytes
            if (concealed && !await StillConcealedAsync(page, ct).ConfigureAwait(false)) return [];

            return png;
        }
        finally
        {
            await RevealAsync(page).ConfigureAwait(false);
        }
    }

    // false when any frame or element would not hide: the caller falls back to masks
    private async Task<bool> ConcealAsync(IPage page, CancellationToken ct)
    {
        var all = true;

        foreach (var frame in page.Frames)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                var missed = await frame.EvaluateAsync<int>(ConcealScript, _probes).ConfigureAwait(false);
                if (missed > 0)
                {
                    _logger.LogDebug(
                        "{Missed} element(s) in frame {Url} would not be concealed; masking instead",
                        missed, Describe(frame));
                    all = false;
                }
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                _logger.LogDebug(ex, "frame {Url} could not be concealed; masking instead", Describe(frame));
                all = false;
            }
        }

        return all;
    }

    private async Task<bool> StillConcealedAsync(IPage page, CancellationToken ct)
    {
        foreach (var frame in page.Frames)
        {
            ct.ThrowIfCancellationRequested();

            string[] bad;
            try
            {
                bad = await frame.EvaluateAsync<string[]>(ConcealedProbeScript, _probes).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                _logger.LogWarning(ex, "discarding the capture: frame {Url} could not be re-checked", Describe(frame));
                return false;
            }

            if (bad.Length > 0)
            {
                // Field KEYS are manifest metadata, never values.
                _logger.LogWarning(
                    "discarding the capture: {Fields} became visible or filled while it was being taken",
                    string.Join(", ", bad.Distinct(StringComparer.Ordinal)));
                return false;
            }
        }

        return true;
    }

    // never takes the caller's token: a cancelled capture must still leave a usable login form
    private async Task RevealAsync(IPage page)
    {
        foreach (var frame in page.Frames)
        {
            try
            {
                await frame.EvaluateAsync(RevealScript).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                _logger.LogDebug(ex, "frame {Url} could not be restored after a capture", Describe(frame));
            }
        }
    }

    public async Task<string?> DomDigestAsync(IPage page, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);
        ct.ThrowIfCancellationRequested();

        if (page.IsClosed) return null;

        try
        {
            var skeleton = await page.MainFrame.EvaluateAsync<string>(SkeletonScript).ConfigureAwait(false);
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(skeleton));
            return "sha256:" + Convert.ToHexStringLower(digest);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            _logger.LogDebug(ex, "no dom digest: the page could not be walked");
            return null;
        }
    }

    private List<ILocator> MaskLocators(IPage page)
    {
        var masks = new List<ILocator>(page.Frames.Count);
        foreach (var frame in page.Frames)
        {
            masks.Add(frame.Locator(_maskSelector));
        }

        return masks;
    }

    // adapters name fields after the provider's own inputs; the password-input rule covers the rest
    private static string SelectorFor(FieldSpec field)
    {
        var key = Escape(field.Key);
        var selectors = new List<string>
        {
            $"[name=\"{key}\"]",
            $"[id=\"{key}\"]",
            $"[data-testid=\"{key}\"]",
            $"[data-test=\"{key}\"]",
        };

        if (!string.IsNullOrWhiteSpace(field.Autofill))
        {
            selectors.Add($"[autocomplete=\"{Escape(field.Autofill)}\"]");
        }

        return string.Join(", ", selectors);
    }

    private static string Escape(string value) =>
        value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

    private static string Describe(IFrame frame) => string.IsNullOrEmpty(frame.Url) ? "<about:blank>" : frame.Url;
}
