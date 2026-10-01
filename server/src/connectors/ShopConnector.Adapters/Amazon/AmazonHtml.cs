using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace ShopConnector.Adapters.Amazon;

/// <summary>
/// The three kinds of node this parser keeps. Comments, doctypes and
/// processing instructions are dropped: nothing downstream reads them, and
/// keeping them would only widen the surface a malformed page can break.
/// </summary>
internal enum HtmlNodeKind
{
    Document,
    Element,
    Text,
}

/// <summary>
/// One node of a parsed page.
///
/// Amazon is the only provider in this service with no API at all - there is
/// no JSON anywhere, because there is no JSON endpoint anywhere - so the
/// order history has to be read out of rendered HTML. That could be done by
/// evaluating JavaScript inside Playwright, and it is tempting because the
/// browser already has a real DOM. It is rejected here for one reason: a
/// parser that only exists inside a live browser can only be tested against a
/// live account, which is exactly the thing this platform cannot spend. A
/// small tree in C# means every selector, every Dutch label and every euro
/// amount is exercised offline against a recorded page.
/// </summary>
internal sealed class HtmlNode
{
    public HtmlNodeKind Kind { get; init; }

    /// <summary>Lowercased tag name. Empty for text.</summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>Raw (still encoded) text for a text node.</summary>
    public string Value { get; init; } = string.Empty;

    public Dictionary<string, string> Attributes { get; } = new(StringComparer.OrdinalIgnoreCase);

    public List<HtmlNode> Children { get; } = [];

    public HtmlNode? Parent { get; set; }

    public string? Attribute(string name) => Attributes.TryGetValue(name, out var value) ? value : null;

    /// <summary>Every element below this node, in document order.</summary>
    public IEnumerable<HtmlNode> Elements()
    {
        foreach (var child in Children)
        {
            if (child.Kind == HtmlNodeKind.Element) yield return child;

            foreach (var deeper in child.Elements()) yield return deeper;
        }
    }

    /// <summary>
    /// The visible text of this subtree: entity-decoded, whitespace
    /// collapsed, and with script and style contents left out so a page's own
    /// JavaScript cannot be mistaken for a label or an amount.
    /// </summary>
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

            // A block boundary is a space. Without this "Totaal:</span><span>€ 5,00"
            // reads as "Totaal:€ 5,00" and a label match that expects a
            // separator quietly stops matching.
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

    /// <summary>
    /// Decode, then flatten every kind of space a rendered page uses, then
    /// collapse. The order matters: <c>&amp;nbsp;</c> only becomes a
    /// non-breaking space after decoding, and an amount written
    /// <c>"€&amp;nbsp;12,50"</c> is otherwise not the same string as
    /// <c>"€ 12,50"</c>.
    /// </summary>
    public static string Normalize(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;

        // The Replace chain a naive version would use needs literal
        // non-breaking and thin spaces in the source, which survive a
        // round trip through an editor only by luck. .NET's \s already
        // matches every Unicode space separator, so collapsing does the
        // job; only the zero-width characters need naming, because they
        // are not whitespace to the regex and not visible to a human -
        // and one sitting inside "€ 1.234,56" would fail the parse.
        var decoded = ZeroWidth.Replace(WebUtility.HtmlDecode(raw), string.Empty);

        return Whitespace.Replace(decoded, " ").Trim();
    }
}

/// <summary>
/// A forgiving HTML tokenizer.
///
/// Deliberately not a spec-compliant parser: it handles the shapes a
/// server-rendered retail page actually contains - unclosed table cells and
/// list items, unquoted attributes, self-closing tags, raw script bodies -
/// and ignores everything else. A missing element is never guessed at; it
/// surfaces upstream as <c>ProviderChanged</c> naming the selector that found
/// nothing.
/// </summary>
internal static class HtmlParser
{
    private static readonly HashSet<string> VoidElements = new(StringComparer.Ordinal)
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    };

    /// <summary>Elements whose content is text, not markup.</summary>
    private static readonly HashSet<string> RawTextElements = new(StringComparer.Ordinal)
    {
        "script", "style", "textarea", "title",
    };

    /// <summary>Elements whose text is never part of the page's visible content.</summary>
    private static readonly HashSet<string> HiddenTextElements = new(StringComparer.Ordinal)
    {
        "script", "style", "head", "noscript", "template",
    };

    /// <summary>
    /// Which open elements a newly opened one implicitly closes. Amazon's
    /// order pages are table-heavy and generated, and generated table markup
    /// routinely omits <c>&lt;/td&gt;</c>.
    /// </summary>
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

    /// <summary>
    /// Reads whatever the <c>&lt;</c> at <paramref name="lt"/> begins - a
    /// comment, a doctype, a close tag or an element - into the tree, and
    /// says where the next read starts.
    /// </summary>
    private static int ReadMarkup(string html, int lt, List<HtmlNode> open)
    {
        // <!-- comment -->, <!doctype>, <?pi?> - all skipped whole.
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

            // A close tag that never closes is the end of anything readable.
            if (end < 0) return html.Length;

            Close(open, html[(lt + 2)..end].Trim().ToLowerInvariant());
            return end + 1;
        }

        return ReadElement(html, lt, open);
    }

    /// <summary>
    /// Reads the element whose open tag starts at <paramref name="lt"/>:
    /// attached under the innermost open element, and left open itself unless
    /// it is void, self-closed or raw text. Says where the next read starts.
    /// </summary>
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

    /// <summary>
    /// The body of a raw-text element - a script, a style, a textarea, a
    /// title - taken as one text node up to its own close tag, however much
    /// markup it looks like it contains. Says where the next read starts.
    /// </summary>
    private static int ReadRawText(string html, HtmlNode element, int from)
    {
        var close = IndexOfClose(html, element.Name, from);
        AddText(element, close < 0 ? html[from..] : html[from..close]);

        if (close < 0) return html.Length;

        return AfterOrEnd(html, html.IndexOf('>', close), 1);
    }

    /// <summary>
    /// The index just past a delimiter found at <paramref name="at"/>, or the
    /// end of the page when it was not found: an unterminated construct runs
    /// to the end rather than failing the parse.
    /// </summary>
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

        // A close tag with nothing open to match is stray markup, not a
        // reason to abandon the page.
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

    /// <summary>The index just past the tag name that starts at <paramref name="i"/>.</summary>
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

    /// <summary>
    /// One attribute - bare, or with a quoted or unquoted value - read into
    /// <paramref name="attributes"/> with its value decoded. Says where the
    /// next read starts.
    /// </summary>
    private static int ReadAttribute(string html, int i, List<KeyValuePair<string, string>> attributes)
    {
        var nameStart = i;
        while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '=' && html[i] != '>' && html[i] != '/') i++;

        var attributeName = html[nameStart..i];

        // A character that starts no name - a stray equals sign - is stepped
        // over rather than read as one.
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

    /// <summary>
    /// An attribute's value starting at <paramref name="i"/>: up to the
    /// matching quote, or for a bare one up to the next space or <c>&gt;</c>.
    /// Says where the next read starts.
    /// </summary>
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

/// <summary>
/// The subset of CSS this service needs, and not one selector more.
///
/// Tag, <c>#id</c>, <c>.class</c>, <c>[attr]</c> with <c>=</c>, <c>*=</c>,
/// <c>^=</c>, <c>$=</c> and <c>~=</c>, an optional <c>i</c> flag, the
/// descendant and child combinators, and comma alternatives. That covers
/// every selector an operator will realistically need to correct in
/// <see cref="AmazonOptions"/>, and each unsupported construct is one fewer
/// way for a hand-edited selector to mean something other than it looks like.
/// </summary>
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

    /// <summary>
    /// The first candidate that matches anything, mirroring
    /// <see cref="Support.PageOps"/>' most-specific-first contract so an
    /// options list behaves the same whether it is resolved against a live
    /// page or a recorded one.
    /// </summary>
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

    /// <summary>Whether the element carries every class the step names.</summary>
    private static bool HasClasses(HtmlNode node, string[] wanted)
    {
        var classAttribute = node.Attribute("class");
        if (classAttribute is null) return false;

        var classes = classAttribute.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return wanted.All(name => classes.Contains(name, StringComparer.Ordinal));
    }

    /// <summary>
    /// Whether the element passes one attribute test: present, and where the
    /// test states a value, related to it the way its operator says.
    /// </summary>
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

    /// <summary>
    /// The index just past the compound selector starting at
    /// <paramref name="i"/>: up to the next whitespace or child combinator,
    /// with every bracketed attribute test skipped whole so a combinator
    /// quoted inside one does not end it early.
    /// </summary>
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

    /// <summary>
    /// The index just past the attribute test whose <c>[</c> is at
    /// <paramref name="i"/>. Brackets nest and a quoted value is skipped
    /// whole, so a <c>]</c> inside one does not close the test.
    /// </summary>
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

    /// <summary>
    /// The index just past the quoted run whose opening quote is at
    /// <paramref name="i"/> - or one past the end when it never closes.
    /// </summary>
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

    /// <summary>Whether <paramref name="c"/> begins an id, a class or an attribute test.</summary>
    private static bool IsMarker(char c) => c is '#' or '.' or '[';

    /// <summary>The index of the next marker at or after <paramref name="i"/>, or the end.</summary>
    private static int EndOfToken(string compound, int i)
    {
        while (i < compound.Length && !IsMarker(compound[i])) i++;
        return i;
    }

    /// <summary>
    /// Compiles the attribute test whose <c>[</c> sits just before
    /// <paramref name="i"/> into <paramref name="attributes"/>, and says where
    /// the next read starts. A test that never closes runs to the end.
    /// </summary>
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
                // A quoted run is one unit: a separator inside it splits nothing.
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
