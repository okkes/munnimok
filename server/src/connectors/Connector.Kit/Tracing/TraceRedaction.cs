using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Connector.Kit.Tracing;

/// <summary>
/// What a recording may never contain, applied before anything is written
/// into the book: a credential, a session token, a cookie value, a signed
/// URL. The adapter author reads a trace to learn WHICH call carries the
/// session and WHAT a response looks like; the value of a bearer token
/// teaches them nothing and leaks the operator's own account if the trace
/// is ever shared.
///
/// Two rules, by name and by value. By name: a header or a field whose name
/// says secret (authorization, cookie, anything with token or password in
/// it) is masked wherever it appears - headers, query strings, form posts,
/// JSON bodies. By value: every string the run was handed as a secret input
/// or as session material is replaced wherever it appears, which catches the
/// password echoed back in an error page under a name nobody predicted.
/// </summary>
public static partial class TraceRedaction
{
    public const string Mask = "«redacted»";

    /// <summary>
    /// A rewritten JSON body keeps the mask as the characters it is rather
    /// than as escapes: the book holds text for a person to read, and the
    /// wire escapes what it must on the way out anyway.
    /// </summary>
    private static readonly JsonSerializerOptions Relaxed = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private const int MinimumSecretLength = 4;

    private static readonly HashSet<string> SecretHeaderNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "x-csrf-token",
        "x-xsrf-token",
        "x-api-key",
        "x-auth-token",
        "x-access-token",
        "x-session-token",
        "x-amz-security-token",
    };

    [GeneratedRegex("(pass|pwd|pin|secret|token|otp|credential|auth|session|cookie|signature|private|api[-_]?key|bearer)", RegexOptions.IgnoreCase)]
    private static partial Regex SecretKeyPattern { get; }

    [GeneratedRegex("(\"(?<key>[^\"]*(?:pass|pwd|pin|secret|token|otp|credential|auth|session|cookie|signature|private|api[-_]?key)[^\"]*)\"\\s*:\\s*\")(?<value>(?:[^\"\\\\]|\\\\.)*)\"", RegexOptions.IgnoreCase)]
    private static partial Regex JsonSecretPairPattern { get; }

    /// <summary>Whether a header's value must be masked, by its name alone.</summary>
    public static bool IsSecretHeader(string name) =>
        SecretHeaderNames.Contains(name) || SecretKeyPattern.IsMatch(name);

    /// <summary>Whether a field, query or JSON key names a secret.</summary>
    public static bool IsSecretKey(string key) => SecretKeyPattern.IsMatch(key);

    /// <summary>A header as the book keeps it: the name always, the value only when it is nobody's secret.</summary>
    public static string Header(string name, string value)
    {
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(value);

        if (name.Equals("cookie", StringComparison.OrdinalIgnoreCase)) return CookieHeader(value);
        if (name.Equals("set-cookie", StringComparison.OrdinalIgnoreCase)) return SetCookieHeader(value);

        if (name.Equals("authorization", StringComparison.OrdinalIgnoreCase)
            || name.Equals("proxy-authorization", StringComparison.OrdinalIgnoreCase))
        {
            var space = value.IndexOf(' ', StringComparison.Ordinal);
            return space > 0 ? $"{value[..space]} {Masked(value.Length - space - 1)}" : Masked(value.Length);
        }

        return IsSecretHeader(name) ? Masked(value.Length) : value;
    }

    /// <summary>A URL without its user-info and with every secret-named query value masked.</summary>
    public static string Url(string url)
    {
        ArgumentNullException.ThrowIfNull(url);

        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return url;

        var builder = new StringBuilder();
        builder.Append(parsed.Scheme).Append("://").Append(parsed.Authority).Append(parsed.AbsolutePath);

        if (parsed.Query.Length > 1)
        {
            builder.Append('?');
            var first = true;
            foreach (var pair in parsed.Query[1..].Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                if (!first) builder.Append('&');
                first = false;

                var eq = pair.IndexOf('=', StringComparison.Ordinal);
                if (eq < 0)
                {
                    builder.Append(pair);
                    continue;
                }

                var key = pair[..eq];
                var val = pair[(eq + 1)..];
                builder.Append(key).Append('=').Append(IsSecretKey(Uri.UnescapeDataString(key)) ? Masked(val.Length) : val);
            }
        }

        if (parsed.Fragment.Length > 0) builder.Append(parsed.Fragment);
        return builder.ToString();
    }

    /// <summary>
    /// A body with its secret-named fields masked: JSON is walked, a form
    /// post is split, anything else is left to the by-value scrub.
    /// </summary>
    public static string Body(string? contentType, string body)
    {
        ArgumentNullException.ThrowIfNull(body);
        if (body.Length == 0) return body;

        if (IsJson(contentType) || LooksLikeJson(body)) return JsonBody(body);
        if (IsForm(contentType)) return FormBody(body);

        return body;
    }

    /// <summary>Every secret value, wherever it appears, replaced by the mask.</summary>
    public static string Values(string text, IReadOnlyCollection<string> secrets)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(secrets);

        if (text.Length == 0) return text;

        var result = text;
        foreach (var secret in secrets)
        {
            if (secret.Length < MinimumSecretLength) continue;
            result = result.Replace(secret, Mask, StringComparison.Ordinal);
        }

        return result;
    }

    /// <summary>A cookie value's fingerprint: its length and a short hash. Never the value.</summary>
    public static (int Length, string Hash) Fingerprint(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return (value.Length, Convert.ToHexStringLower(digest)[..12]);
    }

    /// <summary>Whether a content type carries text the book may keep (JSON, XML, HTML, plain text, a form).</summary>
    public static bool IsText(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType)) return false;

        var media = MediaType(contentType);
        return media.StartsWith("text/", StringComparison.Ordinal)
               || media.EndsWith("/json", StringComparison.Ordinal)
               || media.EndsWith("+json", StringComparison.Ordinal)
               || media.EndsWith("/xml", StringComparison.Ordinal)
               || media.EndsWith("+xml", StringComparison.Ordinal)
               || media == "application/x-www-form-urlencoded"
               || media == "application/javascript";
    }

    /// <summary>Script, style, image, font and media bodies are noise to an adapter author: size and type only.</summary>
    public static bool IsWorthReading(string? contentType)
    {
        if (!IsText(contentType)) return false;

        var media = MediaType(contentType!);
        return media is not ("text/css" or "application/javascript" or "text/javascript");
    }

    public static string Masked(int length) =>
        string.Create(CultureInfo.InvariantCulture, $"«redacted:{length}»");

    private static string MediaType(string contentType)
    {
        var semicolon = contentType.IndexOf(';', StringComparison.Ordinal);
        return (semicolon < 0 ? contentType : contentType[..semicolon]).Trim().ToLowerInvariant();
    }

    private static bool IsJson(string? contentType) =>
        contentType is not null
        && (MediaType(contentType).EndsWith("/json", StringComparison.Ordinal)
            || MediaType(contentType).EndsWith("+json", StringComparison.Ordinal));

    private static bool IsForm(string? contentType) =>
        contentType is not null && MediaType(contentType) == "application/x-www-form-urlencoded";

    private static bool LooksLikeJson(string body)
    {
        var trimmed = body.AsSpan().TrimStart();
        return trimmed.Length > 0 && trimmed[0] is '{' or '[';
    }

    private static string CookieHeader(string value)
    {
        var parts = value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var kept = new List<string>(parts.Length);

        foreach (var part in parts)
        {
            var eq = part.IndexOf('=', StringComparison.Ordinal);
            kept.Add(eq < 0 ? part : $"{part[..eq]}={Masked(part.Length - eq - 1)}");
        }

        return string.Join("; ", kept);
    }

    private static string SetCookieHeader(string value)
    {
        var semicolon = value.IndexOf(';', StringComparison.Ordinal);
        var pair = semicolon < 0 ? value : value[..semicolon];
        var attributes = semicolon < 0 ? string.Empty : value[semicolon..];

        var eq = pair.IndexOf('=', StringComparison.Ordinal);
        var masked = eq < 0 ? Masked(pair.Length) : $"{pair[..eq]}={Masked(pair.Length - eq - 1)}";
        return masked + attributes;
    }

    private static string JsonBody(string body)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(body);
        }
        catch (JsonException)
        {
            // Not JSON after all, or cut short: the by-name rule still
            // runs as a pattern over the text, so a secret under a telling
            // name is masked even when the document cannot be walked.
            return JsonSecretPairPattern.Replace(body, m => $"{m.Groups[1].Value}{Masked(m.Groups["value"].Length)}\"");
        }

        if (node is null) return body;

        var touched = MaskNode(node, depth: 0);
        return touched ? node.ToJsonString(Relaxed) : body;
    }

    private static bool MaskNode(JsonNode node, int depth)
    {
        if (depth > 32) return false;

        var touched = false;
        switch (node)
        {
            case JsonObject obj:
            {
                foreach (var key in obj.Select(p => p.Key).ToList())
                {
                    var child = obj[key];
                    if (IsSecretKey(key) && child is JsonValue leaf)
                    {
                        var text = leaf.ToJsonString();
                        obj[key] = JsonValue.Create(Masked(Math.Max(0, text.Length - 2)));
                        touched = true;
                    }
                    else if (child is not null)
                    {
                        touched |= MaskNode(child, depth + 1);
                    }
                }

                break;
            }

            case JsonArray array:
                foreach (var item in array)
                {
                    if (item is not null) touched |= MaskNode(item, depth + 1);
                }

                break;

            default:
                break;
        }

        return touched;
    }

    private static string FormBody(string body) => string.Join('&', body.Split('&').Select(MaskFormPair));

    private static string MaskFormPair(string pair)
    {
        var eq = pair.IndexOf('=', StringComparison.Ordinal);
        if (eq < 0) return pair;

        var key = Uri.UnescapeDataString(pair[..eq].Replace('+', ' '));
        return IsSecretKey(key) ? $"{pair[..eq]}={Masked(pair.Length - eq - 1)}" : pair;
    }
}
