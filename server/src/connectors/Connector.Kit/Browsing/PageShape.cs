using System.Text;
using System.Text.Json;
using Connector.Kit.Normalization;

namespace Connector.Kit.Browsing;

// structure only, never what a page says about an account: selectors, roles, field names, counts; text only from headings
// and alerts, capped. A bank greets people by name, so a shape is safe to READ but should be skimmed before publishing
public static class PageShape
{
    private const string SelectorKey = "selector";

    private static readonly string[] CutCounts = ["buttons", "headings"];

    // every value-bearing read is absent by construction: never input .value or image bytes; text only from headings and
    // alerts, cut to 80 chars (a bank loading screen's "heading" was 2000 chars of minified javascript)
    public const string Script = """
    () => {
      const pick = s => [...document.querySelectorAll(s)];
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const text = el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);

      // A selector somebody can paste. Id first because it is the stable one,
      // then the attributes a provider actually names things with, and a bare
      // tag last so that an element with no handle at all is still reported as
      // present rather than dropped.
      const sel = el => {
        if (el.id) return '#' + el.id;
        for (const a of ['data-test', 'data-testid', 'name', 'aria-label']) {
          const v = el.getAttribute(a);
          if (v) return el.tagName.toLowerCase() + '[' + a + "='" + v.slice(0, 40) + "']";
        }
        const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
        return cls ? el.tagName.toLowerCase() + '.' + cls.slice(0, 40) : el.tagName.toLowerCase();
      };

      const inputs = pick('input, select, textarea').filter(vis).map(el => ({
        // Type and name only. Never el.value - that is the credential.
        kind: (el.getAttribute('type') || el.tagName.toLowerCase()),
        selector: sel(el),
        autocomplete: el.getAttribute('autocomplete') || null,
        inputmode: el.getAttribute('inputmode') || null,
        maxlength: el.getAttribute('maxlength') || null,
      })).slice(0, 20);

      // A CAP THAT SAYS SO WHEN IT BITES. This list used to stop silently at
      // twelve, and a capture of ASN's export form with its account dialog open
      // held exactly twelve - so the dialog's own buttons were cut off and the
      // report still read like a complete account of the page. A truncated list
      // that cannot be told from a short one is worse than no list: it was read
      // as proof that a control was absent, and two wrong diagnoses came out of
      // it.
      // AN ICON BUTTON IS NOT AN UNNAMED BUTTON, and reporting it as one cost
      // two live sign-outs. ASN's header is three buttons that all report as
      // button[data-testid='button'] with no text - a design system's component
      // name where a handle should be - so the shape read as a page with
      // nothing on it, and the only thing that told them apart was the
      // aria-label this never looked at. A control with no text has its name
      // somewhere else or it is unusable to anybody using a screen reader.
      const name = el => {
        const t = text(el);
        if (t) return t;
        return (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80);
      };

      // TRUNCATED, NOT DROPPED. This used to discard any button whose label ran
      // past forty characters, which is the same silent cap as the twelve
      // below: a control that is missing from the list reads as a control that
      // is not on the page, and this file has already been reasoned from that
      // way twice. Noise can be skimmed past; an absence cannot be seen.
      const allButtons = pick('button, [role=button], input[type=submit], a.button').filter(vis)
        .map(el => {
          const full = name(el);
          return { selector: sel(el), label: full.length < 40 ? full : full.slice(0, 39) + '…' };
        });

      // TWENTY-FOUR, RAISED FROM TWELVE BY A PAGE THAT NEEDED THIRTEEN. ASN's
      // export form with its account dialog open holds fourteen buttons, so the
      // cap cut the last two - and the confirm this connector needed was one of
      // them. The marker below reported "NOT SHOWN: 2 more buttons", which is
      // how that was found rather than guessed at for a third time.
      const buttons = allButtons.slice(0, 24);

      // Anything that could BE a qr code. Dimensions rather than content: a
      // square canvas of a couple of hundred pixels is the tell, and reading
      // its bytes would be reading the code itself.
      const codes = pick('canvas, svg, img').filter(vis).map(el => {
        const r = el.getBoundingClientRect();
        return { selector: sel(el), tag: el.tagName.toLowerCase(),
                 w: Math.round(r.width), h: Math.round(r.height),
                 square: Math.abs(r.width - r.height) < 8 && r.width > 80 };
      }).filter(c => c.w > 40).slice(0, 10);

      // Short runs of digits shown as TEXT, which is the shape of a
      // challenge number a device is keyed with. Reported as a length and a
      // selector, never as the digits - the number is the second factor.
      const shown = pick('output, span, div, p, strong, b').filter(vis).filter(el => {
        if (el.children.length) return false;
        const t = (el.textContent || '').trim();
        return /^[0-9][0-9 \-]{4,15}$/.test(t);
      }).map(el => ({ selector: sel(el), digits: (el.textContent || '').replace(/\D/g, '').length }))
        .slice(0, 6);

      const said = pick('[role=alert], [class*=error i], [id*=error i], [class*=notification i]')
        .filter(vis).map(text).filter(t => t.length > 2 && t.length < 200);

      // A heading that is actually SOURCE CODE is dropped. ASN's signed-out
      // page put an inline script inside a heading element, so the report
      // carried "var greeting; var hours = new Date().getHours(); if (hours"
      // as though it were something the page said. The 80-character cap kept
      // it from being pages of it; this keeps it out entirely.
      const allHeadings = [...new Set(pick('h1,h2,h3').filter(vis).map(text).filter(Boolean))]
        .filter(t => !/[{};]|\bvar\b|=>|function\s*\(/.test(t));

      // THE SAME RULE AS THE LINKS BELOW, and it was missing here. A live run
      // reported "at: .../onlinebankieren/rekening/13101081" - the account
      // holder's own account id, carried out of their bank in the one field
      // nobody had thought to filter, while the link list beside it was
      // dropping the identical path.
      const path = location.pathname.split('/')
        .map(s => /\d{4,}/.test(s) ? '{id}' : s).join('/');

      return {
        url: location.origin + path,
        title: (document.title || '').slice(0, 80),
        // A heading that is actually SOURCE CODE is dropped. ASN's signed-out
        // page put an inline script inside a heading element, so the report
        // carried "var greeting; var hours = new Date().getHours(); if (hours"
        // as though it were something the page said. The 80-character cap kept
        // it from being pages of it; this keeps it out entirely.
        headings: allHeadings.slice(0, 6),
        said: [...new Set(said)].slice(0, 4),
        inputs, buttons, codes, shown,

        // What each cap swallowed, so a short list and a cut one can be told
        // apart. Counts only - the things themselves were dropped for a reason.
        cut: {
          buttons: allButtons.length - Math.min(allButtons.length, 24),
          headings: allHeadings.length - Math.min(allHeadings.length, 6),
        },
        links: [...new Set(pick('a[href]').filter(vis)
          .map(a => { try { return new URL(a.href).pathname; } catch { return null; } })
          .filter(p => p && p.length > 1 && !/\d{4,}/.test(p)))].slice(0, 14),
      };
    }
    """;

    // reads go through JsonRead, so an unexpected probe answer thins the description instead of throwing mid-login
    public static string Describe(JsonElement shape)
    {
        var text = new StringBuilder();

        Add(text, "at", shape.Text("url"));
        Add(text, "title", shape.Text("title"));
        Add(text, "headings", Join(shape.Items("headings").Select(h => h.Text())));
        Add(text, "says", Join(shape.Items("said").Select(s => s.Text())));

        Add(text, "inputs", Join(shape.Items("inputs").Objects().Select(i =>
            $"{i.Text("kind")} {i.Text(SelectorKey)}"
            + (i.Text("autocomplete") is { } a ? $" autocomplete={a}" : string.Empty)
            + (i.Text("maxlength") is { } m ? $" maxlength={m}" : string.Empty))));

        Add(text, "buttons", Join(shape.Items("buttons").Objects().Select(b =>
            $"{b.Text(SelectorKey)} \"{b.Text("label")}\"")));

        Add(text, "images", Join(shape.Items("codes").Objects().Select(c =>
            $"{c.Text(SelectorKey)} {c.Int32("w")}x{c.Int32("h")}"
            + (c.Flag("square") ? " SQUARE" : string.Empty))));

        Add(text, "digit-runs", Join(shape.Items("shown").Objects().Select(s =>
            $"{s.Text(SelectorKey)} ({s.Int32("digits")} digits)")));

        Add(text, "links", Join(shape.Items("links").Select(l => l.Text())));

        // a capped list must say so: a cut list read as complete was twice taken as proof a control was absent (ASN export form)
        var cut = shape.Child("cut");
        var lost = CutCounts
            .Select(what => (What: what, Count: cut.Int32(what) ?? 0))
            .Where(l => l.Count > 0)
            .Select(l => $"{l.Count} more {l.What}")
            .ToList();

        if (lost.Count > 0) Add(text, "NOT SHOWN", Join(lost));

        return text.Length == 0 ? "the page described itself as nothing at all" : text.ToString();
    }

    private static string? Join(IEnumerable<string?> parts)
    {
        var kept = parts.Where(p => !string.IsNullOrWhiteSpace(p)).ToList();

        return kept.Count == 0 ? null : string.Join(", ", kept);
    }

    private static void Add(StringBuilder text, string label, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        if (text.Length > 0) text.Append(" | ");

        text.Append(label).Append(": ").Append(value);
    }
}
