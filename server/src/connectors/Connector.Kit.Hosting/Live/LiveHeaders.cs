using System.Globalization;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Microsoft.AspNetCore.Http;

namespace Connector.Kit.Hosting.Live;

// the frame's shape travels beside the bytes: the consumer maps taps to fractions,
// the platform notices a mid-login re-render at another size
public static class LiveHeaders
{
    /// <summary>Monotonic per job. The consumer sends the last one it saw back as <c>after</c>.</summary>
    public const string Sequence = "X-Live-Sequence";

    /// <summary><c>390x844</c>. Pixels, because a size is the one thing that cannot be a fraction of itself.</summary>
    public const string Size = "X-Live-Size";

    /// <summary>
    /// Whose page the frame is of: <c>https://login.ah.nl</c>. Optional, and
    /// its absence means unknown rather than acceptable.
    /// </summary>
    public const string Origin = "X-Live-Origin";


    /// <summary>
    /// A frame is never worth re-reading and must never be written down by
    /// anything between here and the human's screen.
    /// </summary>
    public const string NoStore = "no-store";

    // fixed, not echoed from the POST: an echoed type would let a browser reinterpret an upload as other than a picture
    public const string Jpeg = "image/jpeg";

    // no default: a frame without a sequence can neither replace the held one nor be skipped
    public static long RequireSequence(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var raw = request.Headers[Sequence].ToString();
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var sequence)
            ? sequence
            : throw ConnectorException.InvalidRequest($"{Sequence} must be a whole number");
    }

    public static (int Width, int Height) RequireSize(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var raw = request.Headers[Size].ToString();
        var parts = raw.Split('x');

        if (parts.Length == 2
            && int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var width)
            && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var height)
            && width > 0 && height > 0)
        {
            return (width, height);
        }

        throw ConnectorException.InvalidRequest($"{Size} must be '<width>x<height>' in whole pixels");
    }

    public static string FormatSize(int width, int height) =>
        string.Create(CultureInfo.InvariantCulture, $"{width}x{height}");

    public static string FormatSequence(long sequence) =>
        sequence.ToString(CultureInfo.InvariantCulture);

    // optional: an agent that cannot establish an origin must still deliver the picture, shown as unknown
    // normalised, not trusted: origin only (no query token), http/https only,
    // and PUNYCODE so a homograph like аh.nl shows as ASCII
    public static string? ReadOrigin(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        // re-normalised though the agent did it: the agent is another process on another machine
        return LiveOrigin.Normalize(request.Headers[Origin].ToString());
    }

    // absent means nothing seen: long.MinValue, below every sequence, so a consumer counting from zero gets its first event
    public static long After(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var raw = request.Query["after"].ToString();
        if (string.IsNullOrWhiteSpace(raw)) return long.MinValue;

        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var after)
            ? after
            : throw ConnectorException.InvalidRequest("after must be a whole number");
    }

    // the cap is enforced while reading: Content-Length may be absent or lie
    public static async Task<byte[]> ReadFrameAsync(HttpRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (request.ContentLength > LiveChannel.MaxFrameBytes) throw TooLarge();

        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];

        while (true)
        {
            var read = await request.Body.ReadAsync(chunk, ct);
            if (read == 0) break;

            if (buffer.Length + read > LiveChannel.MaxFrameBytes) throw TooLarge();
            await buffer.WriteAsync(chunk.AsMemory(0, read), ct);
        }

        return buffer.Length == 0
            ? throw ConnectorException.InvalidRequest("a live frame POST carries the image bytes as its body")
            : buffer.ToArray();
    }

    private static ConnectorException TooLarge() =>
        ConnectorException.InvalidRequest(
            $"a live frame is at most {LiveChannel.MaxFrameBytes} bytes");
}
