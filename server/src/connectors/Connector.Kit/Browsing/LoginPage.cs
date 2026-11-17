using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using Microsoft.Playwright;

namespace Connector.Kit.Browsing;

public sealed record PageMatch(CropRegion? Crop);

// the seam puts decisions taken after a form is submitted (widget or picture, ask a human or refuse, which input takes the
// username, clearing the password before a photo) in the offline suite; shared because AH and Lidl Plus meet the same walls
// and two copies would let the redactor's rule drift. PlaywrightLoginPage is what only a live run exercises
public interface ILoginPage
{
    /// <summary>The page's current URL. Quoted in diagnostics, never as a credential.</summary>
    string Url { get; }

    Task GotoAsync(string url, CancellationToken ct);

    // the redactor refuses to photograph while a secret-declared field holds content; once credentials went upstream the form's
    // copy is needed by nothing and is the only reason that refusal fires
    Task ClearSecretsAsync(CancellationToken ct);

    Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct);

    // best effort: returns when the frame settled or the budget ran out, and the caller photographs either way
    // (live: hCaptcha was photographed mid-swap and the owner got an empty spinner panel). Default does nothing:
    // a page that cannot observe drawing yields a slower picture at worst, never a different outcome
    Task SettleAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct) =>
        Task.CompletedTask;

    // reads the exact bytes DigiD drew for its login QR (inline data: PNG) rather than a photograph: the live view's JPEG stream
    // fails to decode ~1.5% of QR codes. Null is an ordinary answer (the caller polls for it), so a page may default to it
    Task<string?> AttributeAsync(
        IReadOnlyList<string> selectors, string attribute, int timeoutMs, CancellationToken ct) =>
        Task.FromResult<string?>(null);

    // false when nothing matched: the caller decides what a missing field means.
    // filling something else instead is never the answer
    Task<bool> FillAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct);

    Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct);

    // false when nothing matched: the answer went nowhere
    Task<bool> AnswerAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct);
}

public sealed class PlaywrightLoginPage : ILoginPage
{
    // blanks matched inputs in shadow roots too (a modern login form often sits in one; querySelectorAll does not pierce
    // them), the same walk as the redactor's probe: clearing less than it inspects leaves the capture refused for a field
    // nobody can see
    private const string ClearScript = @"
(selectors) => {
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

  let cleared = 0;
  for (const root of roots) {
    for (const selector of selectors) {
      let els;
      try { els = root.querySelectorAll(selector); } catch (e) { continue; }
      for (const el of els) {
        if (typeof el.value !== 'string' && !el.hasAttribute('value')) continue;
        // Through the native setter, and then announced: a framework that
        // holds its own copy of the value writes it straight back on the
        // next render, so a plain assignment can put the password back on
        // the page moments after we took it off.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (setter && setter.set) { setter.set.call(el, ''); } else { el.value = ''; }
        el.removeAttribute('value');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        cleared++;
      }
    }
  }
  return cleared;
}";

    private readonly IPage _page;
    private readonly string[] _secretSelectors;

    public PlaywrightLoginPage(IPage page, ProviderManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(manifest);

        _page = page;
        _secretSelectors = SecretSelectors(manifest);
    }

    public string Url => _page.Url;

    public async Task GotoAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await _page.GotoAsync(url).ConfigureAwait(false);
    }

    public async Task ClearSecretsAsync(CancellationToken ct)
    {
        foreach (var frame in _page.Frames)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                await frame.EvaluateAsync(ClearScript, _secretSelectors).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // a frame that cannot be scripted (detached mid-navigation, cross-origin) cannot be vouched for; the redactor refuses
                // it too: no image rather than one we cannot stand behind
            }
        }
    }

    public async Task<PageMatch?> FindAsync(
        IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        var handle = await PageOps.FindAsync(_page, selectors, timeoutMs, ct).ConfigureAwait(false);
        if (handle is null) return null;

        return new PageMatch(await PageOps.CropAsync(handle).ConfigureAwait(false));
    }

    public async Task SettleAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + budget;

        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();

            var drawn = await PageOps.IsDrawnAsync(_page, selectors, ct).ConfigureAwait(false);

            // settled as far as it will get: finished-and-broken images are not "still loading", else one 404 waits out the whole budget
            if (drawn != DrawState.Pending) return;

            await Task.Delay(PageOps.SettlePollMs, ct).ConfigureAwait(false);
        }
    }

    public async Task<string?> AttributeAsync(
        IReadOnlyList<string> selectors, string attribute, int timeoutMs, CancellationToken ct)
    {
        var element = await PageOps.FindAsync(_page, selectors, timeoutMs, ct).ConfigureAwait(false);

        return element is null ? null : await element.GetAttributeAsync(attribute).ConfigureAwait(false);
    }

    public async Task<bool> FillAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        var input = await PageOps.FindAsync(_page, selectors, timeoutMs, ct).ConfigureAwait(false);
        if (input is null) return false;

        await input.FillAsync(value, new() { Timeout = timeoutMs }).ConfigureAwait(false);
        return true;
    }

    // the timeout bounds the click as well as the search: DUO's chooser parks real radios off-screen and Playwright's default
    // 30s retry blew a 4s step that was meant to give up quickly and hand the page to the human
    public async Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        var target = await PageOps.FindAsync(_page, selectors, timeoutMs, ct).ConfigureAwait(false);
        if (target is null) return false;

        await target.ClickAsync(new() { Timeout = timeoutMs }).ConfigureAwait(false);
        return true;
    }

    public async Task<bool> AnswerAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        var input = await PageOps.FindAsync(_page, selectors, timeoutMs, ct).ConfigureAwait(false);
        if (input is null) return false;

        await input.FillAsync(value, new() { Timeout = timeoutMs }).ConfigureAwait(false);
        await input.PressAsync("Enter", new() { Timeout = timeoutMs }).ConfigureAwait(false);
        return true;
    }

    // a copy of the redactor's rule (it lives in the agent, which an adapter cannot reach): the two lists must agree, same order
    private static string[] SecretSelectors(ProviderManifest manifest)
    {
        var selectors = new List<string> { "input[type=password]", "input[autocomplete*=password i]" };

        foreach (var field in manifest.Auth.AllFields().Where(f => f.Secret))
        {
            var key = Escape(field.Key);
            selectors.Add($"[name=\"{key}\"]");
            selectors.Add($"[id=\"{key}\"]");
            selectors.Add($"[data-testid=\"{key}\"]");
            selectors.Add($"[data-test=\"{key}\"]");

            if (!string.IsNullOrWhiteSpace(field.Autofill))
            {
                selectors.Add($"[autocomplete=\"{Escape(field.Autofill)}\"]");
            }
        }

        return [.. selectors.Distinct(StringComparer.Ordinal)];
    }

    private static string Escape(string value) =>
        value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);
}
