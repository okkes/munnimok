using System.Globalization;
using System.Text;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Http;

namespace Connector.Kit.Hosting.Live;

/// <summary>
/// One picture as the pushed live view carries it (#429): the frame route's
/// headers and body, in one event.
/// </summary>
/// <param name="Sequence">Monotonic per job; also the event's id, which a reconnect sends back.</param>
/// <param name="Width">Pixels, the size every returned fraction is multiplied by.</param>
/// <param name="Height">Pixels.</param>
/// <param name="Origin">Whose page this is (<c>https://login.ah.nl</c>), absent when unknown.</param>
/// <param name="Jpeg">The JPEG, base64 on the wire - bytes, so the writer emits the alphabet unescaped.</param>
public sealed record LiveStreamFrame(long Sequence, int Width, int Height, string? Origin, byte[] Jpeg);

/// <summary>
/// The pushed live view (#429): one server-sent event per picture, so a
/// consumer holds one response for the whole login instead of asking for
/// every frame.
///
/// <code>
/// retry: 1000
///
/// id: 12
/// event: frame
/// data: {"sequence":12,"width":390,"height":844,"origin":"https://login.ah.nl","jpeg":"/9j/4AAQ…"}
///
/// : keep-alive
///
/// event: end
/// data: {"code":"challenge_expired"}
/// </code>
///
/// The id is the frame's sequence, so a reconnect names the last picture it
/// drew (<c>Last-Event-ID</c>, or <c>?after=</c>) and is handed the current
/// one only when it is newer. There is no backlog to replay: the slot holds
/// one picture, and a reconnect wants the login as it is now. <c>end</c> is
/// the platform's "this live view is over" - the same word the frame route
/// answers 410 with - so a consumer can tell it from a dropped connection,
/// which it reconnects.
/// </summary>
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

    /// <summary>
    /// How often the run behind the stream is read again. The frame slot
    /// cannot say that the challenge was answered or the session moved on;
    /// the rows can, and reading them per frame would be a dozen queries a
    /// second for an answer that changes once.
    /// </summary>
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

    /// <summary>
    /// Where a (re)connecting stream starts: the <c>Last-Event-ID</c> a
    /// reconnect carries, else <c>?after=</c>, else "nothing seen yet".
    /// </summary>
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
