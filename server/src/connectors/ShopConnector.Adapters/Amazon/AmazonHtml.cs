using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace ShopConnector.Adapters.Amazon;

internal enum HtmlNodeKind
{
    Document,
    Element,
    Text,
}

/// Amazon has no API, so order history is read from rendered HTML. Evaluating JavaScript in Playwright is rejected:
/// a parser living only in a live browser can only be tested against a live account, which this platform cannot spend;
/// a C# tree is tested offline on recorded pages.
internal sealed class HtmlNode
{
    public HtmlNodeKind Kind { get; init; }

    public string Name { get; init; } = string.Empty;

    /// <summary>Raw (still encoded) text for a text node.</summary>
    public string Value { get; init; } = string.Empty;

    public Dictionary<string, string> Attributes { get; } = new(StringComparer.OrdinalIgnoreCase);

    public List<HtmlNode> Children { get; } = [];

    public HtmlNode? Parent { get; set; }

    public string? Attribute(string name) => Attributes.TryGetValue(name, out var value) ? value : null;

    public IEnumerable<HtmlNode> Elements()
    {
        foreach (var child in Children)
        {
            if (child.Kind == HtmlNodeKind.Element) yield return child;

            foreach (var deeper in child.Elements()) yield return deeper;
        }
    }

    /// entity-decoded, whitespace collapsed, script and style left out so a page's JavaScript cannot pass as a label or amount
    public string Text()
    {
        var builder = new StringBuilder();
        Append(this, builder);
        return HtmlText.Normalize(builder.ToString());
    }

    private static void Append(HtmlNode node, StringBuilder builder)
    {
        if (node.Kind == HtmlNodeKind.Text)
        {
            builder.Append(node.Value);
            return;
        }

        if (HtmlParser.IsHiddenText(node.Name)) return;

        foreach (var child in node.Children)
        {
            Append(child, builder);

            // a block boundary is a space: otherwise "Totaal:</span><span>€ 5,00" reads "Totaal:€ 5,00" and label matches stop matching
            if (child.Kind == HtmlNodeKind.Element) builder.Append(' ');
        }
    }
}

internal static partial class HtmlText
{
    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace { get; }

    [GeneratedRegex(@"[\u200B\u200C\u200D\uFEFF]")]
    private static partial Regex ZeroWidth { get; }

    /// the order matters: an entity only becomes a non-breaking space after decoding
    public static string Normalize(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;

        // .NET's \s already matches every Unicode space separator; only zero-width characters need naming:
        // not whitespace to the regex, and one inside "€ 1.234,56" fails the parse
        var decoded = ZeroWidth.Replace(WebUtility.HtmlDecode(raw), string.Empty);

        return Whitespace.Replace(decoded, " ").Trim();
    }
}

/// deliberately not spec-compliant: only the shapes of a server-rendered retail page (unclosed cells, unquoted attributes,
/// raw script bodies); a missing element is never guessed, it surfaces as ProviderChanged naming the selector
internal static class HtmlParser
{
    private static readonly HashSet<string> VoidElements = new(StringComparer.Ordinal)
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    };

    private static readonly HashSet<string> RawTextElements = new(StringComparer.Ordinal)
    {
        "script", "style", "textarea", "title",
    };

    private static readonly HashSet<string> HiddenTextElements = new(StringComparer.Ordinal)
    {
        "script", "style", "head", "noscript", "template",
    };

    /// Amazon's order pages are generated table markup, which routinely omits closing td tags
    private static readonly Dictionary<string, string[]> ClosesOpen = new(StringComparer.Ordinal)
    {
        ["li"] = ["li"],
        ["p"] = ["p"],
        ["option"] = ["option"],
        ["dd"] = ["dd", "dt"],
        ["dt"] = ["dd", "dt"],
        ["td"] = ["td", "th"],
        ["th"] = ["td", "th"],
        ["tr"] = ["td", "th", "tr"],
        ["tbody"] = ["td", "th", "tr", "thead", "tbody"],
        ["thead"] = ["td", "th", "tr"],
        ["tfoot"] = ["td", "th", "tr", "thead", "tbody"],
    };

    public static bool IsHiddenText(string tag) => HiddenTextElements.Contains(tag);

    public static HtmlNode Parse(string? html)
    {
        var document = new HtmlNode { Kind = HtmlNodeKind.Document, Name = "#document" };
        if (string.IsNullOrEmpty(html)) return document;

        var open = new List<HtmlNode> { document };
        var index = 0;

        while (index < html.Length)
        {
            var lt = html.IndexOf('<', index);
            if (lt < 0)
            {
                AddText(open[^1], html[index..]);
                break;
            }

            if (lt > index) AddText(open[^1], html[index..lt]);

            index = ReadMarkup(html, lt, open);
        }

        return document;
    }

    private static int ReadMarkup(string html, int lt, List<HtmlNode> open)
    {
        if (Starts(html, lt, "<!--"))
        {
            return AfterOrEnd(html, html.IndexOf("-->", lt + 4, StringComparison.Ordinal), 3);
        }

        if (lt + 1 < html.Length && (html[lt + 1] == '!' || html[lt + 1] == '?'))
        {
            return AfterOrEnd(html, html.IndexOf('>', lt), 1);
        }

        if (lt + 1 < html.Length && html[lt + 1] == '/')
        {
            var end = html.IndexOf('>', lt);

            if (end < 0) return html.Length;

            Close(open, html[(lt + 2)..end].Trim().ToLowerInvariant());
            return end + 1;
        }

        return ReadElement(html, lt, open);
    }

    private static int ReadElement(string html, int lt, List<HtmlNode> open)
    {
        var tag = ReadTag(html, lt);
        if (tag.Name.Length == 0) return tag.Next;

        AutoClose(open, tag.Name);

        var element = new HtmlNode { Kind = HtmlNodeKind.Element, Name = tag.Name };
        foreach (var (key, value) in tag.Attributes) element.Attributes[key] = value;
        Attach(open[^1], element);

        if (tag.SelfClosing || VoidElements.Contains(tag.Name)) return tag.Next;
        if (RawTextElements.Contains(tag.Name)) return ReadRawText(html, element, tag.Next);

        open.Add(element);
        return tag.Next;
    }

    private static int ReadRawText(string html, HtmlNode element, int from)
    {
        var close = IndexOfClose(html, element.Name, from);
        AddText(element, close < 0 ? html[from..] : html[from..close]);

        if (close < 0) return html.Length;

        return AfterOrEnd(html, html.IndexOf('>', close), 1);
    }

    /// an unterminated construct runs to the end of the page rather than failing the parse
    private static int AfterOrEnd(string html, int at, int length) => at < 0 ? html.Length : at + length;

    private static bool Starts(string html, int at, string token) =>
        at + token.Length <= html.Length && html.AsSpan(at, token.Length).SequenceEqual(token);

    private static void Attach(HtmlNode parent, HtmlNode child)
    {
        child.Parent = parent;
        parent.Children.Add(child);
    }

    private static void AddText(HtmlNode parent, string raw)
    {
        if (raw.Length == 0) return;
        Attach(parent, new HtmlNode { Kind = HtmlNodeKind.Text, Value = raw });
    }

    private static void Close(List<HtmlNode> open, string name)
    {
        for (var i = open.Count - 1; i > 0; i--)
        {
            if (!string.Equals(open[i].Name, name, StringComparison.Ordinal)) continue;

            open.RemoveRange(i, open.Count - i);
            return;
        }

        // a close tag with nothing open is stray markup, not a reason to abandon the page
    }

    private static void AutoClose(List<HtmlNode> open, string name)
    {
        if (!ClosesOpen.TryGetValue(name, out var closes)) return;

        while (open.Count > 1 && closes.Contains(open[^1].Name, StringComparer.Ordinal))
        {
            open.RemoveAt(open.Count - 1);
        }
    }

    private static int IndexOfClose(string html, string name, int from)
    {
        var needle = "</" + name;
        for (var i = from; i >= 0 && i < html.Length;)
        {
            var hit = html.IndexOf(needle, i, StringComparison.OrdinalIgnoreCase);
            if (hit < 0) return -1;

            var after = hit + needle.Length;
            if (after >= html.Length || html[after] == '>' || char.IsWhiteSpace(html[after])) return hit;

            i = after;
        }

        return -1;
    }

    private readonly record struct TagRead(
        string Name, List<KeyValuePair<string, string>> Attributes, bool SelfClosing, int Next);

    private static TagRead ReadTag(string html, int lt)
    {
        var start = lt + 1;
        var i = EndOfTagName(html, start);

        var name = html[start..i].ToLowerInvariant();
        var attributes = new List<KeyValuePair<string, string>>();
        var selfClosing = false;

        while (i < html.Length)
        {
            i = SkipWhitespace(html, i);
            if (i >= html.Length) break;

            if (html[i] == '>')
            {
                i++;
                break;
            }

            if (html[i] == '/')
            {
                selfClosing = true;
                i++;
                continue;
            }

            i = ReadAttribute(html, i, attributes);
        }

        return new TagRead(name, attributes, selfClosing, i);
    }

    private static int EndOfTagName(string html, int i)
    {
        while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '>' && html[i] != '/') i++;
        return i;
    }

    private static int SkipWhitespace(string html, int i)
    {
        while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
        return i;
    }

    private static int ReadAttribute(string html, int i, List<KeyValuePair<string, string>> attributes)
    {
        var nameStart = i;
        while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '=' && html[i] != '>' && html[i] != '/') i++;

        var attributeName = html[nameStart..i];

        // a character that starts no name (a stray equals sign) is stepped over
        if (attributeName.Length == 0) return i + 1;

        i = SkipWhitespace(html, i);

        var value = string.Empty;
        if (i < html.Length && html[i] == '=')
        {
            (value, i) = ReadAttributeValue(html, SkipWhitespace(html, i + 1));
        }

        attributes.Add(new KeyValuePair<string, string>(attributeName, WebUtility.HtmlDecode(value)));
        return i;
    }

    private static (string Value, int Next) ReadAttributeValue(string html, int i)
    {
        if (i < html.Length && (html[i] == '"' || html[i] == '\''))
        {
            var quote = html[i++];
            var valueStart = i;
            while (i < html.Length && html[i] != quote) i++;

            var quoted = html[valueStart..Math.Min(i, html.Length)];
            if (i < html.Length) i++;
            return (quoted, i);
        }

        var bareStart = i;
        while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '>') i++;
        return (html[bareStart..i], i);
    }
}

/// the subset of CSS needed and no more: each unsupported construct is one fewer way for a hand-edited selector
/// to mean something other than it looks like
internal static class HtmlQuery
{
    private static readonly ConcurrentDictionary<string, Alternative[]> Cache = new(StringComparer.Ordinal);

    public static IReadOnlyList<HtmlNode> All(HtmlNode root, string selector)
    {
        ArgumentNullException.ThrowIfNull(root);

        var parsed = Cache.GetOrAdd(selector, Compile);
        if (parsed.Length == 0) return [];

        return root.Elements()
            .Where(element => parsed.Any(
                alternative => Matches(element, alternative.Steps, alternative.Steps.Length - 1)))
            .ToList();
    }

    public static IReadOnlyList<HtmlNode> All(HtmlNode root, IReadOnlyList<string> selectors)
    {
        foreach (var selector in selectors)
        {
            var hits = All(root, selector);
            if (hits.Count > 0) return hits;
        }

        return [];
    }

    public static HtmlNode? First(HtmlNode root, string selector)
    {
        var hits = All(root, selector);
        return hits.Count > 0 ? hits[0] : null;
    }

    /// mirrors PageOps' most-specific-first contract, so an options list behaves the same against a live or a recorded page
    public static HtmlNode? First(HtmlNode root, IReadOnlyList<string> selectors)
    {
        foreach (var selector in selectors)
        {
            if (First(root, selector) is { } hit) return hit;
        }

        return null;
    }

    public static string? TextOf(HtmlNode root, IReadOnlyList<string> selectors)
    {
        var hit = First(root, selectors);
        if (hit is null) return null;

        var text = hit.Text();
        return text.Length == 0 ? null : text;
    }

    private static bool Matches(HtmlNode node, Step[] steps, int index)
    {
        if (!MatchesCompound(node, steps[index])) return false;
        if (index == 0) return true;

        if (steps[index].Child)
        {
            return node.Parent is { Kind: HtmlNodeKind.Element } parent && Matches(parent, steps, index - 1);
        }

        for (var ancestor = node.Parent; ancestor is not null; ancestor = ancestor.Parent)
        {
            if (ancestor.Kind != HtmlNodeKind.Element) continue;
            if (Matches(ancestor, steps, index - 1)) return true;
        }

        return false;
    }

    private static bool MatchesCompound(HtmlNode node, Step step)
    {
        if (node.Kind != HtmlNodeKind.Element) return false;

        if (step.Tag is { } tag && !string.Equals(node.Name, tag, StringComparison.Ordinal)) return false;

        if (step.Id is { } id && !string.Equals(node.Attribute("id"), id, StringComparison.Ordinal)) return false;

        if (step.Classes.Length > 0 && !HasClasses(node, step.Classes)) return false;

        return step.Attributes.All(test => MatchesAttribute(node, test));
    }

    private static bool HasClasses(HtmlNode node, string[] wanted)
    {
        var classAttribute = node.Attribute("class");
        if (classAttribute is null) return false;

        var classes = classAttribute.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return wanted.All(name => classes.Contains(name, StringComparer.Ordinal));
    }

    private static bool MatchesAttribute(HtmlNode node, AttributeTest test)
    {
        if (node.Attribute(test.Name) is not { } actual) return false;
        if (test.Value is null) return true;

        var comparison = test.CaseInsensitive ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return test.Operator switch
        {
            '=' => actual.Equals(test.Value, comparison),
            '*' => actual.Contains(test.Value, comparison),
            '^' => actual.StartsWith(test.Value, comparison),
            '$' => actual.EndsWith(test.Value, comparison),
            '~' => actual.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Any(part => part.Equals(test.Value, comparison)),
            _ => false,
        };
    }

    private static Alternative[] Compile(string selector)
    {
        var alternatives = new List<Alternative>();

        foreach (var part in SplitTopLevel(selector, ','))
        {
            var steps = CompileAlternative(part);
            if (steps.Length > 0) alternatives.Add(new Alternative(steps));
        }

        return [.. alternatives];
    }

    private static Step[] CompileAlternative(string selector)
    {
        var steps = new List<Step>();
        var i = 0;
        var child = false;

        while (i < selector.Length)
        {
            if (char.IsWhiteSpace(selector[i]))
            {
                i++;
                continue;
            }

            if (selector[i] == '>')
            {
                child = true;
                i++;
                continue;
            }

            var start = i;
            i = EndOfCompound(selector, i);

            var compound = selector[start..i];
            if (compound.Length > 0)
            {
                steps.Add(CompileCompound(compound, child && steps.Count > 0));
                child = false;
            }
        }

        return [.. steps];
    }

    /// bracketed tests are skipped whole so a combinator quoted inside one does not end the compound early
    private static int EndOfCompound(string selector, int i)
    {
        while (i < selector.Length && !char.IsWhiteSpace(selector[i]) && selector[i] != '>')
        {
            if (selector[i] == '[')
            {
                i = EndOfBracket(selector, i);
                continue;
            }

            i++;
        }

        return i;
    }

    /// brackets nest and a quoted value is skipped whole, so a closing bracket inside one does not close the test
    private static int EndOfBracket(string selector, int i)
    {
        var depth = 1;
        i++;

        while (i < selector.Length && depth > 0)
        {
            if (selector[i] == '[') depth++;
            else if (selector[i] == ']') depth--;
            else if (selector[i] is '"' or '\'')
            {
                i = AfterQuoted(selector, i);
                continue;
            }

            i++;
        }

        return i;
    }

    private static int AfterQuoted(string selector, int i)
    {
        var quote = selector[i++];
        while (i < selector.Length && selector[i] != quote) i++;
        return i + 1;
    }

    private static Step CompileCompound(string compound, bool child)
    {
        string? tag = null;
        string? id = null;
        var classes = new List<string>();
        var attributes = new List<AttributeTest>();

        var i = 0;
        if (!IsMarker(compound[0]))
        {
            i = EndOfToken(compound, 0);

            var name = compound[..i];
            if (!string.Equals(name, "*", StringComparison.Ordinal)) tag = name.ToLowerInvariant();
        }

        while (i < compound.Length)
        {
            var marker = compound[i++];

            if (marker == '[')
            {
                i = ReadAttributeTest(compound, i, attributes);
                continue;
            }

            var start = i;
            i = EndOfToken(compound, i);

            var token = compound[start..i];
            if (token.Length == 0) continue;

            if (marker == '#') id = token;
            else if (marker == '.') classes.Add(token);
        }

        return new Step(tag, id, [.. classes], [.. attributes], child);
    }

    private static bool IsMarker(char c) => c is '#' or '.' or '[';

    private static int EndOfToken(string compound, int i)
    {
        while (i < compound.Length && !IsMarker(compound[i])) i++;
        return i;
    }

    private static int ReadAttributeTest(string compound, int i, List<AttributeTest> attributes)
    {
        var close = compound.IndexOf(']', i);
        if (close < 0) close = compound.Length;

        attributes.Add(CompileAttribute(compound[i..close]));
        return Math.Min(close + 1, compound.Length);
    }

    private static AttributeTest CompileAttribute(string body)
    {
        var caseInsensitive = false;
        var text = body.Trim();

        if (text.EndsWith(" i", StringComparison.OrdinalIgnoreCase))
        {
            caseInsensitive = true;
            text = text[..^2].Trim();
        }

        var equals = text.IndexOf('=', StringComparison.Ordinal);
        if (equals < 0) return new AttributeTest(text, '\0', null, caseInsensitive);

        var op = '=';
        var nameEnd = equals;
        if (equals > 0 && text[equals - 1] is '*' or '^' or '$' or '~' or '|')
        {
            op = text[equals - 1];
            nameEnd = equals - 1;
        }

        var value = text[(equals + 1)..].Trim();
        if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0])
        {
            value = value[1..^1];
        }

        return new AttributeTest(text[..nameEnd].Trim(), op, value, caseInsensitive);
    }

    private static IEnumerable<string> SplitTopLevel(string selector, char separator)
    {
        var depth = 0;
        var start = 0;
        var i = 0;

        while (i < selector.Length)
        {
            var c = selector[i];
            if (c == '[') depth++;
            else if (c == ']') depth--;
            else if (c is '"' or '\'')
            {
                // a quoted run is one unit: a separator inside it splits nothing
                i = AfterQuoted(selector, i);
                continue;
            }
            else if (c == separator && depth <= 0)
            {
                yield return selector[start..i];
                start = i + 1;
            }

            i++;
        }

        yield return selector[start..];
    }

    private sealed record Alternative(Step[] Steps);

    private readonly record struct Step(
        string? Tag, string? Id, string[] Classes, AttributeTest[] Attributes, bool Child);

    private readonly record struct AttributeTest(string Name, char Operator, string? Value, bool CaseInsensitive);
}
