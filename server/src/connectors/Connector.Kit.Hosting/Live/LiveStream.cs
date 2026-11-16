using System.Globalization;
using System.Text;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Http;

namespace Connector.Kit.Hosting.Live;

// one picture as the pushed live view (#429) carries it; Sequence is also the event id a reconnect sends back
public sealed record LiveStreamFrame(long Sequence, int Width, int Height, string? Origin, byte[] Jpeg);

// pushed live view (#429): one SSE event per picture; a reconnect (Last-Event-ID or ?after=) gets the current one if newer
// `end` = this live view is over (the frame route answers 410); a dropped connection reconnects
public static class LiveStream
{
    public const string ContentType = "text/event-stream";

    public const string FrameEvent = "frame";

    public const string EndEvent = "end";

    public const string LastEventId = "Last-Event-ID";

    /// <summary>The reconnect delay a standard EventSource uses; the app's own reader keeps its own backoff.</summary>
    public const string Retry = "retry: 1000\n\n";

    /// <summary>Written after a quiet stretch so an idle proxy keeps the response open.</summary>
    public const string KeepAlive = ": keep-alive\n\n";

    // the frame slot cannot say the challenge was answered or the session moved on.
    // reading per frame would be a dozen queries a second
    public static readonly TimeSpan RecheckEvery = TimeSpan.FromSeconds(1);

    public static string Frame(LiveFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);

        var data = ConnectorJson.Serialize(new LiveStreamFrame(
            frame.Sequence,
            frame.Width,
            frame.Height,
            frame.Origin is { Length: > 0 } origin ? origin : null,
            frame.Bytes));

        return new StringBuilder(data.Length + 48)
            .Append("id: ").Append(frame.Sequence.ToString(CultureInfo.InvariantCulture)).Append('\n')
            .Append("event: ").Append(FrameEvent).Append('\n')
            .Append("data: ").Append(data).Append("\n\n")
            .ToString();
    }

    /// <param name="code">The refusal the frame route would answer now: <c>challenge_expired</c> in practice.</param>
    public static string End(ErrorCode code) =>
        $"event: {EndEvent}\ndata: {ConnectorJson.Serialize(new { code })}\n\n";

    public static long After(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var resumed = request.Headers[LastEventId].ToString();
        if (string.IsNullOrWhiteSpace(resumed)) return LiveHeaders.After(request);

        return long.TryParse(resumed, NumberStyles.Integer, CultureInfo.InvariantCulture, out var after)
            ? after
            : throw ConnectorException.InvalidRequest($"{LastEventId} must be a whole number");
    }

    public static async Task WriteAsync(HttpResponse response, string text, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(response);

        await response.WriteAsync(text, Encoding.UTF8, ct).ConfigureAwait(false);
        await response.Body.FlushAsync(ct).ConfigureAwait(false);
    }
}
