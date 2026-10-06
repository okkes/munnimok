using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Connector.Kit.Tracing;

/// <summary>
/// The page an adapter author reads first: <c>digest.md</c>, rendered from
/// a trace. The pages visited in order, the calls worth reading grouped by
/// host with the SHAPE of every JSON answer (keys and array lengths, never
/// the values), the forms posted (field names only), the cookie jar at the
/// end, the console's complaints. Everything an adapter needs to know to
/// reproduce the run by hand is here; nothing a person typed is.
/// </summary>
public static class TraceDigest
{
    private const int MaxListed = 200;

    private const int MaxShapeKeys = 12;

    private const int MaxShapeDepth = 3;

    private const int MaxConsoleLines = 20;

    private static readonly HashSet<string> Noise = new(StringComparer.Ordinal)
    {
        "script", "stylesheet", "image", "font", "media", "manifest", "texttrack", "ping", "beacon", "preflight", "other",
    };

    public static string Render(JobTrace trace)
    {
        ArgumentNullException.ThrowIfNull(trace);

        var sb = new StringBuilder();
        var seconds = Math.Max(0, (trace.EndedAt - trace.StartedAt).TotalSeconds);

        sb.Append("# Recording of ").Append(trace.Provider).Append(" · job ").AppendLine(trace.JobId);
        sb.AppendLine();
        sb.Append("Started ").Append(trace.StartedAt.ToString("u", CultureInfo.InvariantCulture))
            .Append(", ran ").Append(seconds.ToString("0", CultureInfo.InvariantCulture)).Append(" s. ")
            .Append(trace.Entries.Count.ToString(CultureInfo.InvariantCulture)).Append(" entries, ")
            .Append(trace.Cookies.Count.ToString(CultureInfo.InvariantCulture)).Append(" cookies at the end.");
        if (trace.Truncated)
        {
            sb.Append(" The book ran out of room: ").Append(trace.Dropped.ToString(CultureInfo.InvariantCulture))
                .Append(" entries were dropped.");
        }

        sb.AppendLine();
        sb.AppendLine();
        sb.AppendLine("Secrets were taken out before anything was written down: a header, field or query value whose name says");
        sb.AppendLine("secret reads `«redacted:n»`, a cookie value is a length and a hash, and every value the run was handed as");
        sb.AppendLine("a credential or session material is masked wherever it appeared.");
        sb.AppendLine();

        Pages(sb, trace);
        Calls(sb, trace);
        Forms(sb, trace);
        Cookies(sb, trace);
        Console(sb, trace);

        return sb.ToString();
    }

    /// <summary>
    /// The shape of a JSON document: keys with the type of each value, an
    /// array as its length and the shape of its first element. Three levels
    /// deep, twelve keys wide, and never a value.
    /// </summary>
    public static string Shape(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return "(not JSON)";
        }

        return node is null ? "null" : Shape(node, 0);
    }

    private static string Shape(JsonNode node, int depth) => node switch
    {
        JsonObject obj => ShapeObject(obj, depth),
        JsonArray array => ShapeArray(array, depth),
        JsonValue value => ShapeValue(value),
        _ => "null",
    };

    private static string ShapeObject(JsonObject obj, int depth)
    {
        if (depth >= MaxShapeDepth) return "{…}";

        var parts = obj.Take(MaxShapeKeys)
            .Select(p => p.Value is null ? $"{p.Key}: null" : $"{p.Key}: {Shape(p.Value, depth + 1)}")
            .ToList();
        if (obj.Count > MaxShapeKeys) parts.Add($"… {obj.Count - MaxShapeKeys} more");
        return "{" + string.Join(", ", parts) + "}";
    }

    private static string ShapeArray(JsonArray array, int depth)
    {
        var first = array.FirstOrDefault(a => a is not null);
        string inner;
        if (first is null) inner = "?";
        else if (depth >= MaxShapeDepth) inner = "…";
        else inner = Shape(first, depth + 1);

        return $"[{array.Count.ToString(CultureInfo.InvariantCulture)} × {inner}]";
    }

    private static string ShapeValue(JsonValue value) => value.GetValueKind() switch
    {
        JsonValueKind.String => "string",
        JsonValueKind.Number => "number",
        JsonValueKind.True or JsonValueKind.False => "bool",
        JsonValueKind.Null => "null",
        _ => "value",
    };

    private static void Pages(StringBuilder sb, JobTrace trace)
    {
        var pages = trace.Entries.Where(e => e.Kind == TraceKind.Navigation).ToList();
        sb.AppendLine("## Pages");
        sb.AppendLine();
        if (pages.Count == 0) sb.AppendLine("No navigation was recorded.");

        foreach (var page in pages.Take(MaxListed))
        {
            var landed = trace.Entries.FirstOrDefault(e =>
                e.Kind == TraceKind.Response && e.ResourceType == "document" && e.Seq > page.Seq);
            sb.Append("- ").Append(Clock(page.AtMs)).Append(' ').Append(page.Url);
            if (landed is not null)
            {
                sb.Append(" → ").Append(landed.Status?.ToString(CultureInfo.InvariantCulture) ?? "?");
                if (landed.ContentType is not null) sb.Append(' ').Append(Media(landed.ContentType));
                if (landed.Size is { } size) sb.Append(' ').Append(Kb(size));
            }

            sb.AppendLine();
        }

        if (pages.Count > MaxListed) sb.Append("- … ").Append(pages.Count - MaxListed).AppendLine(" more");
        sb.AppendLine();
    }

    private static void Calls(StringBuilder sb, JobTrace trace)
    {
        var responses = trace.Entries
            .Where(e => e.Kind == TraceKind.Response && IsWorthListing(e))
            .ToList();

        sb.AppendLine("## Calls worth reading");
        sb.AppendLine();
        sb.AppendLine("Documents, XHR and fetch calls from the browser, and every call the HTTP client made; scripts, styles, images");
        sb.AppendLine("and fonts are left out. A JSON answer is shown as its shape.");
        sb.AppendLine();
        if (responses.Count == 0) sb.AppendLine("Nothing worth reading was recorded.");

        foreach (var group in responses.GroupBy(Host).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            sb.Append("### ").AppendLine(group.Key);
            sb.AppendLine();
            foreach (var call in group.Take(MaxListed)) CallLine(sb, call);

            var count = group.Count();
            if (count > MaxListed) sb.Append("- … ").Append(count - MaxListed).AppendLine(" more");
            sb.AppendLine();
        }
    }

    private static void CallLine(StringBuilder sb, TraceEntry call)
    {
        sb.Append("- ").Append(Clock(call.AtMs)).Append(' ')
            .Append(call.Method ?? "GET").Append(' ').Append(PathOf(call.Url))
            .Append(" → ").Append(call.Status?.ToString(CultureInfo.InvariantCulture) ?? "?");
        if (call.ContentType is not null) sb.Append(' ').Append(Media(call.ContentType));
        if (call.Size is { } size) sb.Append(' ').Append(Kb(size));
        if (call.Via == TraceBook.ViaHttp) sb.Append(" (http client)");
        sb.AppendLine();

        if (call.Body is { Length: > 0 } body && IsJson(call.ContentType) && !call.BodyTruncated)
        {
            sb.Append("  - shape: `").Append(Shape(body)).AppendLine("`");
        }
    }

    private static void Forms(StringBuilder sb, JobTrace trace)
    {
        var posts = trace.Entries
            .Where(e => e.Kind == TraceKind.Request && e.Body is { Length: > 0 } && IsWrite(e.Method))
            .ToList();

        sb.AppendLine("## Forms and bodies posted");
        sb.AppendLine();
        if (posts.Count == 0) sb.AppendLine("Nothing was posted.");

        foreach (var post in posts.Take(MaxListed))
        {
            sb.Append("- ").Append(Clock(post.AtMs)).Append(' ').Append(post.Method).Append(' ').Append(post.Url)
                .Append(" — fields: ").AppendLine(FieldNames(post.ContentType, post.Body!));
        }

        sb.AppendLine();
    }

    private static void Cookies(StringBuilder sb, JobTrace trace)
    {
        sb.AppendLine("## Cookies at the end");
        sb.AppendLine();
        if (trace.Cookies.Count == 0)
        {
            sb.AppendLine("None.");
            sb.AppendLine();
            return;
        }

        sb.AppendLine("| name | domain | path | flags | expires | value |");
        sb.AppendLine("|---|---|---|---|---|---|");
        foreach (var cookie in trace.Cookies.OrderBy(c => c.Domain, StringComparer.Ordinal).ThenBy(c => c.Name, StringComparer.Ordinal))
        {
            var flags = string.Join(' ', new[]
            {
                cookie.HttpOnly ? "httpOnly" : null,
                cookie.Secure ? "secure" : null,
                cookie.SameSite is { Length: > 0 } s ? "sameSite=" + s : null,
            }.Where(f => f is not null));

            sb.Append("| ").Append(cookie.Name)
                .Append(" | ").Append(cookie.Domain)
                .Append(" | ").Append(cookie.Path)
                .Append(" | ").Append(flags.Length == 0 ? "—" : flags)
                .Append(" | ").Append(cookie.Expires?.ToString("u", CultureInfo.InvariantCulture) ?? "session")
                .Append(" | ").Append(cookie.ValueLength.ToString(CultureInfo.InvariantCulture)).Append(" chars, sha256 ").Append(cookie.ValueHash)
                .AppendLine(" |");
        }

        sb.AppendLine();
    }

    private static void Console(StringBuilder sb, JobTrace trace)
    {
        var lines = trace.Entries.Where(e => e.Kind == TraceKind.Console).ToList();
        var errors = lines.Count(l => l.Level is "error" or "pageerror");
        var warnings = lines.Count(l => l.Level is "warning" or "warn");

        sb.AppendLine("## Console");
        sb.AppendLine();
        sb.Append(lines.Count.ToString(CultureInfo.InvariantCulture)).Append(" lines, ")
            .Append(errors.ToString(CultureInfo.InvariantCulture)).Append(" errors, ")
            .Append(warnings.ToString(CultureInfo.InvariantCulture)).AppendLine(" warnings.");

        foreach (var line in lines.Where(l => l.Level is "error" or "pageerror" or "warning" or "warn").Take(MaxConsoleLines))
        {
            sb.Append("- ").Append(Clock(line.AtMs)).Append(" [").Append(line.Level).Append("] ")
                .AppendLine(FirstLine(line.Text));
        }

        sb.AppendLine();
    }

    private static bool IsWorthListing(TraceEntry e) =>
        e.Via == TraceBook.ViaHttp || e.ResourceType is null || !Noise.Contains(e.ResourceType);

    private static bool IsWrite(string? method) =>
        method is not null && method.ToUpperInvariant() is "POST" or "PUT" or "PATCH" or "DELETE";

    private static bool IsJson(string? contentType) =>
        contentType is not null
        && (Media(contentType).EndsWith("/json", StringComparison.Ordinal) || Media(contentType).EndsWith("+json", StringComparison.Ordinal));

    private static string FieldNames(string? contentType, string body)
    {
        if (IsJson(contentType) || body.AsSpan().TrimStart() is ['{', ..])
        {
            try
            {
                if (JsonNode.Parse(body) is JsonObject obj)
                {
                    return string.Join(", ", obj.Select(p => p.Key).Take(MaxShapeKeys * 2));
                }
            }
            catch (JsonException)
            {
                // fall through to the form reading
            }
        }

        var names = body.Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=')[0])
            .Select(k => Uri.UnescapeDataString(k.Replace('+', ' ')))
            .Where(k => k.Length > 0 && k.Length <= 64 && !k.Contains('\n', StringComparison.Ordinal))
            .Take(MaxShapeKeys * 2)
            .ToList();

        return names.Count == 0 ? "(a body that is not a form)" : string.Join(", ", names);
    }

    private static string Host(TraceEntry e) =>
        Uri.TryCreate(e.Url, UriKind.Absolute, out var uri) ? uri.Host : "(no host)";

    private static string PathOf(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.PathAndQuery : url ?? "?";

    private static string Media(string contentType)
    {
        var semicolon = contentType.IndexOf(';', StringComparison.Ordinal);
        return (semicolon < 0 ? contentType : contentType[..semicolon]).Trim();
    }

    private static string Kb(long size) =>
        size < 1024
            ? string.Create(CultureInfo.InvariantCulture, $"{size} B")
            : string.Create(CultureInfo.InvariantCulture, $"{size / 1024.0:0.#} KB");

    private static string Clock(long ms)
    {
        var span = TimeSpan.FromMilliseconds(ms);
        return string.Create(CultureInfo.InvariantCulture, $"{(int)span.TotalMinutes:00}:{span.Seconds:00}.{span.Milliseconds / 100}");
    }

    private static string FirstLine(string? text)
    {
        if (string.IsNullOrEmpty(text)) return string.Empty;
        var nl = text.IndexOf('\n', StringComparison.Ordinal);
        var line = nl < 0 ? text : text[..nl];
        return line.Length > 200 ? line[..200] + "…" : line;
    }
}
