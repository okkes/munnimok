using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using Munni.Api.Auth;

namespace Munni.Api.Connectors;

public static partial class ConnectorRelayEndpoints
{
    /// <summary>
    /// The live view pushed (#429). The app holds one response here for the
    /// whole streamed login and this API holds one stream to the control
    /// plane, handing each frame on as it arrives. The device talks to this
    /// API and nothing else: the control plane and the agents stay on the
    /// private network, and every tap still travels through
    /// <see cref="LiveInput"/>. Refusals come back before the first byte with
    /// the status the frame poll would answer, so a client that cannot hold a
    /// stream polls instead and loses nothing.
    /// </summary>
    private static async Task<IResult> LiveStream(
        string provider, string sessionId, string challengeId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        if (await OwnedAsync(relay.Db, userId, provider, sessionId) is null) return UnknownSession(http);

        if (LiveStreamRelay.ResumeFrom(http.Request) is not { } after)
        {
            return Envelope(http, StatusCodes.Status400BadRequest,
                new ConnectorError("invalid_request", false, "none", "connect.error.invalid_request", null, null));
        }

        using var claim = LiveStreamRelay.Claim(LiveStreamRelay.ViewerKey(userId, provider, sessionId, challengeId), ct);
        using var upstream = await relay.Client.OpenStreamAsync(
            $"v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/stream?after={after.ToString(CultureInfo.InvariantCulture)}",
            new ConnectorCall { Subject = relay.Minter.For(userId) },
            claim.Token);
        if (!upstream.IsSuccessStatusCode) return Relay(http, await ConnectorClient.RefusalOfAsync(upstream, claim.Token));

        await LiveStreamRelay.PumpAsync(upstream, http, claim, LiveStreamRelay.UpstreamSilence);
        return Results.Empty;
    }
}

/// <summary>
/// The relay's half of the pushed live view: what it reads from the control
/// plane, what it writes to the app, and the one stream it keeps per viewer.
/// </summary>
internal static class LiveStreamRelay
{
    public const string ContentType = "text/event-stream";

    /// <summary>
    /// The control plane writes a keep-alive after ten quiet seconds, so three
    /// of them missing is an upstream that is gone without having said so; the
    /// app reconnects past the frame it drew.
    /// </summary>
    public static readonly TimeSpan UpstreamSilence = TimeSpan.FromSeconds(30);

    /// <summary>A frame slot holds at most a megabyte, which is under 1.4 MB of base64; anything longer is not a frame.</summary>
    public const int MaxEventBytes = 2 * 1024 * 1024;

    /// <summary>
    /// The stream each viewer holds, by user, session and challenge. A phone
    /// that switched networks reconnects while its old connection still looks
    /// open here - for as long as TCP takes to give up on it - so the newer
    /// stream takes the place and the older one lets its upstream go at once.
    /// </summary>
    private static readonly ConcurrentDictionary<string, StreamClaim> Open = new(StringComparer.Ordinal);

    /// <summary>The frame the viewer last drew: <c>Last-Event-ID</c> on a reconnect, else <c>?after=</c>; null when it is not a number.</summary>
    public static long? ResumeFrom(HttpRequest request)
    {
        var raw = request.Headers["Last-Event-ID"].ToString();
        if (string.IsNullOrWhiteSpace(raw)) raw = request.Query["after"].ToString();
        if (string.IsNullOrWhiteSpace(raw)) return 0;

        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var after)
            ? Math.Max(0, after)
            : null;
    }

    /// <summary>One viewer of one live view: the person, and the challenge they are watching.</summary>
    public static string ViewerKey(Guid userId, string provider, string sessionId, string challengeId) =>
        $"{userId:N}|{provider}|{sessionId}|{challengeId}";

    /// <summary>Whether the relay holds a stream for this viewer right now.</summary>
    public static bool Holds(string key) => Open.ContainsKey(key);

    public static StreamClaim Claim(string key, CancellationToken aborted)
    {
        var claim = new StreamClaim(key, aborted);
        Open.AddOrUpdate(key, claim, (_, previous) =>
        {
            previous.Supersede();
            return claim;
        });
        return claim;
    }

    /// <summary>
    /// Hands the control plane's events on until either end stops: frames
    /// re-written from what was validated, keep-alives passed through, the
    /// platform's <c>end</c> passed through and final. Nothing after the first
    /// byte throws back at the framework - the response has started, and an
    /// envelope written over it would bury the cause.
    /// </summary>
    public static async Task PumpAsync(HttpResponseMessage upstream, HttpContext http, StreamClaim claim, TimeSpan silence)
    {
        var response = http.Response;
        response.Headers.ContentType = ContentType;
        response.Headers.CacheControl = "no-store";
        // the NAS's reverse proxy is nginx, which buffers a proxied response unless told not to
        response.Headers["X-Accel-Buffering"] = "no";
        http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        using var quiet = CancellationTokenSource.CreateLinkedTokenSource(claim.Token);
        try
        {
            await WriteAsync(response, "retry: 1000\n\n", claim.Token);
            await using var body = await upstream.Content.ReadAsStreamAsync(claim.Token);
            var reader = new SseReader(body, MaxEventBytes);

            while (true)
            {
                quiet.CancelAfter(silence);
                if (await reader.ReadAsync(quiet.Token) is not { } next) return;

                if (Render(next) is not { } text) continue;
                await WriteAsync(response, text, claim.Token);
                if (next.Name == "end") return;
            }
        }
        catch (OperationCanceledException) when (claim.Superseded)
        {
            // A newer stream of the same viewer took over. Said rather than
            // dropped, so a second tab watching the same login stops
            // reconnecting into the first and polls beside it instead.
            await TryWriteAsync(response, "event: superseded\ndata: {}\n\n", http.RequestAborted);
        }
        catch (OperationCanceledException)
        {
            // The app went, or the upstream fell silent.
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or InvalidDataException)
        {
            // The upstream broke off or sent something that is not a stream of
            // frames; the app reconnects and the poll is beside it.
        }
    }

    /// <summary>What the app is handed for one upstream event, or null when it is nobody's business but the relay's.</summary>
    internal static string? Render(SseEvent next)
    {
        if (next.IsComment) return ": keep-alive\n\n";

        return next.Name switch
        {
            "frame" => RenderFrame(next),
            "end" => "event: end\ndata: " + EndData(next.Data) + "\n\n",
            _ => null,
        };
    }

    /// <summary>
    /// A frame as the app reads it, rebuilt from what was checked: the fields
    /// the app draws with and nothing a future control plane might add.
    /// </summary>
    private static string? RenderFrame(SseEvent next)
    {
        if (!long.TryParse(next.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)) return null;

        JsonObject? frame;
        try
        {
            frame = JsonNode.Parse(next.Data ?? string.Empty) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }

        if (frame is null || !TryRead(frame, out var picture) || picture.Sequence != id) return null;

        var buffer = new System.Buffers.ArrayBufferWriter<byte>(picture.Jpeg.Length * 4 / 3 + 256);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("sequence", picture.Sequence);
            writer.WriteNumber("width", picture.Width);
            writer.WriteNumber("height", picture.Height);
            if (picture.Origin is { } origin) writer.WriteString("origin", origin);
            writer.WriteBase64String("jpeg", picture.Jpeg);
            writer.WriteEndObject();
        }

        return $"id: {id.ToString(CultureInfo.InvariantCulture)}\nevent: frame\ndata: {Encoding.UTF8.GetString(buffer.WrittenSpan)}\n\n";
    }

    private readonly record struct Picture(long Sequence, int Width, int Height, string? Origin, byte[] Jpeg);

    private static bool TryRead(JsonObject frame, out Picture picture)
    {
        picture = default;
        try
        {
            var sequence = frame["sequence"]?.GetValue<long>();
            var width = frame["width"]?.GetValue<int>();
            var height = frame["height"]?.GetValue<int>();
            var origin = frame["origin"]?.GetValue<string>();
            var jpeg = frame["jpeg"]?.GetValue<string>();

            if (sequence is not { } s || width is not > 0 || height is not > 0 || string.IsNullOrEmpty(jpeg)) return false;

            var bytes = Convert.FromBase64String(jpeg);
            if (bytes.Length == 0) return false;

            picture = new Picture(s, width.Value, height.Value, string.IsNullOrEmpty(origin) ? null : origin, bytes);
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException)
        {
            return false;
        }
    }

    /// <summary>The platform's reason, kept to the one field the app reads.</summary>
    private static string EndData(string? data)
    {
        string? code = null;
        try
        {
            code = (JsonNode.Parse(data ?? string.Empty) as JsonObject)?["code"]?.GetValue<string>();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            // an end without a readable reason is still the end
        }

        return JsonSerializer.Serialize(new { code = string.IsNullOrEmpty(code) ? "challenge_expired" : code });
    }

    private static async Task WriteAsync(HttpResponse response, string text, CancellationToken ct)
    {
        await response.WriteAsync(text, Encoding.UTF8, ct);
        await response.Body.FlushAsync(ct);
    }

    private static async Task TryWriteAsync(HttpResponse response, string text, CancellationToken ct)
    {
        try
        {
            await WriteAsync(response, text, ct);
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            // the viewer is gone too
        }
    }

    /// <summary>One viewer's hold on a stream; disposing it lets the place go unless a newer stream took it.</summary>
    internal sealed class StreamClaim : IDisposable
    {
        private readonly string _key;
        private readonly CancellationTokenSource _cts;
        private int _superseded;

        public StreamClaim(string key, CancellationToken aborted)
        {
            _key = key;
            _cts = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        }

        public CancellationToken Token => _cts.Token;

        public bool Superseded => Volatile.Read(ref _superseded) == 1;

        public void Supersede()
        {
            Interlocked.Exchange(ref _superseded, 1);
            try
            {
                _cts.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // it had already ended
            }
        }

        public void Dispose()
        {
            Open.TryRemove(new KeyValuePair<string, StreamClaim>(_key, this));
            _cts.Dispose();
        }
    }
}

/// <summary>
/// One server-sent event: its name (<c>message</c> when it gave none), id and
/// data, or a comment block - which is how a keep-alive arrives.
/// </summary>
internal sealed record SseEvent(string Name, string? Id, string? Data, bool IsComment);

/// <summary>
/// Reads server-sent events off a stream, bounded: an event longer than the
/// limit is refused rather than buffered, so a stream that never sends a
/// newline cannot grow this process without end.
/// </summary>
internal sealed class SseReader(Stream stream, int maxEventBytes)
{
    private readonly byte[] _chunk = new byte[16 * 1024];
    private readonly MemoryStream _line = new();
    private int _start;
    private int _end;
    private int _eventBytes;

    /// <summary>The next complete event, or null at the end of the stream (a half-written event is dropped).</summary>
    public async Task<SseEvent?> ReadAsync(CancellationToken ct)
    {
        var block = new Block();
        _eventBytes = 0;

        while (await ReadLineAsync(ct) is { } line)
        {
            if (line.Length > 0) block.Add(line);
            else if (!block.IsEmpty) return block.ToEvent();
        }

        return null;
    }

    /// <summary>The lines of one event as they arrive; a blank line hands it over.</summary>
    private sealed class Block
    {
        private string? _name;
        private string? _id;
        private StringBuilder? _data;
        private bool _comment;

        public bool IsEmpty => _name is null && _id is null && _data is null && !_comment;

        public SseEvent ToEvent() => new(_name ?? "message", _id, _data?.ToString(), _comment && _name is null && _data is null);

        public void Add(string line)
        {
            if (line[0] == ':')
            {
                _comment = true;
                return;
            }

            var colon = line.IndexOf(':', StringComparison.Ordinal);
            var field = colon < 0 ? line : line[..colon];
            var value = colon < 0 ? string.Empty : line[(colon + 1)..];
            if (value.StartsWith(' ')) value = value[1..];

            switch (field)
            {
                case "event":
                    _name = value;
                    break;
                case "id":
                    _id = value;
                    break;
                case "data":
                    _data = _data is null ? new StringBuilder(value) : _data.Append('\n').Append(value);
                    break;
                default:
                    // retry, and whatever a later revision of the format adds
                    break;
            }
        }
    }

    private async Task<string?> ReadLineAsync(CancellationToken ct)
    {
        _line.SetLength(0);

        while (true)
        {
            var newline = Array.IndexOf(_chunk, (byte)'\n', _start, _end - _start);
            if (newline >= 0)
            {
                Take(newline - _start);
                _start = newline + 1;
                return Decode();
            }

            Take(_end - _start);
            _start = 0;
            _end = await stream.ReadAsync(_chunk, ct);
            if (_end == 0) return null;
        }
    }

    private void Take(int count)
    {
        _eventBytes += count;
        if (_eventBytes > maxEventBytes) throw new InvalidDataException($"a server-sent event is at most {maxEventBytes} bytes");
        _line.Write(_chunk, _start, count);
    }

    private string Decode()
    {
        var bytes = _line.GetBuffer().AsSpan(0, (int)_line.Length);
        if (bytes.Length > 0 && bytes[^1] == (byte)'\r') bytes = bytes[..^1];
        return Encoding.UTF8.GetString(bytes);
    }
}
