using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;

namespace ShopConnector.Adapters.Bol;

internal readonly record struct HtmlElement(string Tag, string OpenTag, string Inner);

// hooks are strings in BolOptions, not code: the order page has never been seen (it needs an account)
// the selector subset is tiny and CSS-shaped so an operator can read one off devtools; no HTML parser is on the
// platform's package list, so this is a scanner, not a DOM, and does not repair markup
internal static partial class BolHtml
{
    private static readonly HashSet<string> VoidElements = new(StringComparer.OrdinalIgnoreCase)
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    };

    // one pattern per element: the source generator cannot generate a case-insensitive backreference and would fall back
    // to the interpreter for the whole expression
    [GeneratedRegex(@"<script\b[^>]*>.*?</script\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ScriptBlock { get; }

    [GeneratedRegex(@"<style\b[^>]*>.*?</style\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex StyleBlock { get; }

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex CommentBlock { get; }

    [GeneratedRegex(@"<[^>]*>", RegexOptions.Singleline)]
    private static partial Regex AnyTag { get; }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Runs { get; }

    // applied only to a short opening tag, so backtracking is bounded
    [GeneratedRegex("""([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))""")]
    private static partial Regex AttributePair { get; }

    [GeneratedRegex(@"^(?<tag>[A-Za-z][A-Za-z0-9]*)?(?:\.(?<class>[-\w]+))?(?:\[(?<attr>[-\w:]+)(?:(?<op>[*]?=)(?<val>[^\]]*))?\])?$")]
    private static partial Regex SelectorPattern { get; }

    // "12,50 3" must not read as 12503: space digit grouping is unsupported, the difference between a wrong total and none
    [GeneratedRegex(@"-?\d+(?:[.,]\d+)*")]
    private static partial Regex NumberToken { get; }

    [GeneratedRegex(@"\s*-?\s*\u20AC?\s*\d+(?:[.,]\d+)*\s*-?\s*$")]
    private static partial Regex TrailingPrice { get; }

    // most-specific first: the page has no published contract, so the list is the unit of repair
    public static IReadOnlyList<HtmlElement> All(string html, IReadOnlyList<string> selectors)
    {
        foreach (var selector in selectors)
        {
            var found = All(html, selector);
            if (found.Count > 0) return found;
        }

        return [];
    }

    public static IReadOnlyList<HtmlElement> All(string html, string selector)
    {
        var simple = Parse(selector);
        var results = new List<HtmlElement>();
        var cursor = 0;

        while (NextTag(html, cursor) is { } tag)
        {
            var (open, end) = tag;
            var openTag = html[open..(end + 1)];
            var name = TagName(openTag);

            if (Matches(simple, name, openTag))
            {
                var (inner, after) = Content(html, name, openTag, end);
                results.Add(new HtmlElement(name, openTag, inner));

                // past the whole element so a nested match is not reported twice; line items are read from their block's own content
                cursor = after;
            }
            else
            {
                cursor = end + 1;
            }
        }

        return results;
    }

    public static HtmlElement? First(string html, IReadOnlyList<string> selectors)
    {
        foreach (var selector in selectors)
        {
            var found = All(html, selector);
            if (found.Count > 0) return found[0];
        }

        return null;
    }

    // null and empty are kept apart: a blank element is a different finding from one that is not there
    public static string? TextOf(string html, IReadOnlyList<string> selectors) =>
        First(html, selectors) is { } element ? Text(element.Inner) : null;

    public static string? Attribute(string openTag, string name)
    {
        foreach (var groups in AttributePair.Matches(openTag).Select(pair => pair.Groups))
        {
            if (!string.Equals(groups[1].Value, name, StringComparison.OrdinalIgnoreCase)) continue;

            return WebUtility.HtmlDecode(Unquoted(groups));
        }

        return null;
    }

    public static string? Attribute(string openTag, IReadOnlyList<string> names)
    {
        foreach (var name in names)
        {
            if (Attribute(openTag, name) is { Length: > 0 } value) return value;
        }

        return null;
    }

    private static string Unquoted(GroupCollection groups)
    {
        if (groups[3].Success) return groups[3].Value;

        return groups[4].Success ? groups[4].Value : groups[5].Value;
    }

    // for dates: pages wrap the machine-readable value one level down (a time datetime), which states its offset, unlike prose
    public static string? AttributeWithin(string html, IReadOnlyList<string> names)
    {
        var cursor = 0;

        while (NextTag(html, cursor) is { } tag)
        {
            var (open, end) = tag;

            if (Attribute(html[open..(end + 1)], names) is { Length: > 0 } value) return value;
            cursor = end + 1;
        }

        return null;
    }

    // decoding after the tags are stripped: an entity-encoded tag would otherwise grow a real one
    public static string Text(string fragment)
    {
        var stripped = AnyTag.Replace(
            CommentBlock.Replace(StyleBlock.Replace(ScriptBlock.Replace(fragment, " "), " "), " "), " ");

        var decoded = WebUtility.HtmlDecode(stripped)
            .Replace('\u00A0', ' ')
            .Replace('\u2212', '-')
            .Replace('\u2013', '-');    // en dash, which price ranges and refunds both use

        return Runs.Replace(decoded, " ").Trim();
    }

    // a quantity, never an amount: money goes through MoneyText and a declared MoneyUnit (a misread amount corrupts silently)
    public static decimal? Number(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var match = NumberToken.Match(text);
        if (!match.Success) return null;

        var cleaned = match.Value.Replace(',', '.');

        // several dots are thousands separators; a single one is read as the decimal point
        var dots = cleaned.Count(c => c == '.');
        if (dots > 1) cleaned = cleaned.Replace(".", string.Empty, StringComparison.Ordinal);

        return decimal.TryParse(cleaned, NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    // which number: after a currency symbol, else the first with cents, else the first ("2e halve prijs - € 3,00" is 3)
    // a trailing minus must touch the digits ("4,00-") so the range "€ 10,00 - € 12,00" is not negative
    public static string? MoneyText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var normalized = text.Replace('\u2212', '-').Replace('\u2013', '-');
        var matches = NumberToken.Matches(normalized);
        if (matches.Count == 0) return null;

        var chosen = matches.FirstOrDefault(m => AfterCurrency(normalized, m.Index))
                     ?? matches.FirstOrDefault(m => HasCents(m.Value))
                     ?? matches[0];

        var value = chosen.Value;
        if (value.StartsWith('-')) return value;

        return Negative(normalized, chosen.Index, chosen.Index + chosen.Length) ? "-" + value : value;
    }

    // the text with its price taken out ("2e halve prijs"); null when it was only a price: a label "- 3,00" is worse than none
    public static string? WithoutPrice(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var normalized = text.Replace('\u2212', '-').Replace('\u2013', '-');

        var symbol = normalized.IndexOf('\u20ac');
        var head = symbol >= 0 ? normalized[..symbol] : TrailingPrice.Replace(normalized, string.Empty);

        var trimmed = head.Trim().Trim('-', ':', '\u2013').Trim();
        return trimmed.Length == 0 ? null : trimmed;
    }

    private static bool Negative(string text, int start, int end)
    {
        var i = start - 1;
        while (i >= 0 && (char.IsWhiteSpace(text[i]) || text[i] == '\u20ac')) i--;
        if (i >= 0 && text[i] == '-') return true;

        // Touching, and only touching: a spaced '-' after a price is a range.
        return end < text.Length && text[end] == '-';
    }

    private static bool AfterCurrency(string text, int start)
    {
        var i = start - 1;
        while (i >= 0 && char.IsWhiteSpace(text[i])) i--;
        return i >= 0 && text[i] == '\u20ac';
    }

    // one or two digits after the separator are cents; three are a thousands group ("1.249" is not 1.25)
    private static bool HasCents(string value)
    {
        var separator = value.LastIndexOfAny([',', '.']);
        if (separator < 0) return false;

        var tail = value.Length - separator - 1;
        return tail is 1 or 2;
    }

    private static (int Open, int End)? NextTag(string html, int from)
    {
        var cursor = from;

        while (cursor < html.Length)
        {
            var open = html.IndexOf('<', cursor);
            if (open < 0 || open + 1 >= html.Length) return null;

            if (html.AsSpan(open).StartsWith("<!--", StringComparison.Ordinal))
            {
                cursor = PastComment(html, open);
                continue;
            }

            if (!char.IsAsciiLetter(html[open + 1]))
            {
                cursor = open + 1;
                continue;
            }

            var end = TagEnd(html, open);
            return end < 0 ? null : (open, end);
        }

        return null;
    }

    private static (int At, int End, bool Closing)? NextNamed(string html, string name, int from)
    {
        var cursor = from;

        while (cursor < html.Length)
        {
            var next = html.IndexOf('<', cursor);
            if (next < 0) return null;

            if (html.AsSpan(next).StartsWith("<!--", StringComparison.Ordinal))
            {
                cursor = PastComment(html, next);
                continue;
            }

            var closing = next + 1 < html.Length && html[next + 1] == '/';
            var nameAt = closing ? next + 2 : next + 1;

            if (!Named(html, nameAt, name))
            {
                cursor = next + 1;
                continue;
            }

            var tagEnd = TagEnd(html, next);
            return tagEnd < 0 ? null : (next, tagEnd, closing);
        }

        return null;
    }

    private static int PastComment(string html, int at)
    {
        var closed = html.IndexOf("-->", at, StringComparison.Ordinal);
        return closed < 0 ? html.Length : closed + 3;
    }

    private static int TagEnd(string html, int open)
    {
        var quote = '\0';

        for (var i = open + 1; i < html.Length; i++)
        {
            var c = html[i];

            if (quote != '\0')
            {
                if (c == quote) quote = '\0';
                continue;
            }

            if (c is '"' or '\'') quote = c;
            else if (c == '>') return i;
        }

        return -1;
    }

    private static string TagName(string openTag)
    {
        var length = 0;
        while (1 + length < openTag.Length && char.IsAsciiLetterOrDigit(openTag[1 + length])) length++;
        return openTag.Substring(1, length);
    }

    // an element never closed keeps the rest of the document, as a browser does: no order lost after a stray tag
    private static (string Inner, int After) Content(string html, string name, string openTag, int end)
    {
        if (openTag.EndsWith("/>", StringComparison.Ordinal) || VoidElements.Contains(name))
        {
            return (string.Empty, end + 1);
        }

        var depth = 1;
        var cursor = end + 1;

        while (NextNamed(html, name, cursor) is { } tag)
        {
            var (next, tagEnd, closing) = tag;

            if (closing)
            {
                if (--depth == 0) return (html[(end + 1)..next], tagEnd + 1);
            }
            else if (!html[next..(tagEnd + 1)].EndsWith("/>", StringComparison.Ordinal))
            {
                depth++;
            }

            cursor = tagEnd + 1;
        }

        return (html[(end + 1)..], html.Length);
    }

    private static bool Named(string html, int at, string name)
    {
        if (at + name.Length > html.Length) return false;
        if (!html.AsSpan(at, name.Length).Equals(name, StringComparison.OrdinalIgnoreCase)) return false;

        var following = at + name.Length;
        return following >= html.Length || !char.IsAsciiLetterOrDigit(html[following]);
    }

    private readonly record struct Simple(
        string? Tag, string? Class, string? AttributeName, string? Value, bool Contains);

    private static Simple Parse(string selector)
    {
        var trimmed = selector.Trim();
        var match = SelectorPattern.Match(trimmed);

        if (!match.Success || trimmed.Length == 0)
        {
            // an operator's typo, not a provider's redesign: ProviderChanged here would degrade bol.com for every other user
            throw ConnectorException.InvalidRequest(
                $"bol: '{selector}' is not a supported selector; use tag, .class, [attr], [attr=value] or [attr*=value]");
        }

        var tag = match.Groups["tag"];
        var css = match.Groups["class"];
        var attribute = match.Groups["attr"];

        if (!tag.Success && !css.Success && !attribute.Success)
        {
            throw ConnectorException.InvalidRequest($"bol: selector '{selector}' selects nothing");
        }

        var value = match.Groups["val"].Success ? match.Groups["val"].Value.Trim().Trim('"', '\'') : null;

        return new Simple(
            tag.Success ? tag.Value : null,
            css.Success ? css.Value : null,
            attribute.Success ? attribute.Value : null,
            value,
            match.Groups["op"].Value == "*=");
    }

    private static bool Matches(Simple simple, string tag, string openTag)
    {
        if (simple.Tag is { } wanted && !string.Equals(tag, wanted, StringComparison.OrdinalIgnoreCase)) return false;

        if (simple.Class is { } css)
        {
            var classes = Attribute(openTag, "class");
            if (classes is null) return false;

            var present = classes.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Any(token => string.Equals(token, css, StringComparison.Ordinal));

            if (!present) return false;
        }

        if (simple.AttributeName is not { } attribute) return true;

        var actual = Attribute(openTag, attribute);
        if (actual is null) return false;
        if (simple.Value is not { } expected) return true;

        return simple.Contains
            ? actual.Contains(expected, StringComparison.OrdinalIgnoreCase)
            : string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
    }
}
