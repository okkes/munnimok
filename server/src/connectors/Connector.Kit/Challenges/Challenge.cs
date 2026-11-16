using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Serialization;

namespace Connector.Kit.Challenges;

// questions only the account's owner can answer: relayed, never solved - the line between acting as a user's agent and abuse
[JsonConverter(typeof(JsonStringEnumConverter<ChallengeType>))]
public enum ChallengeType
{
    Image,

    QrDisplay,

    CodeDisplay,

    MfaCode,

    AppApproval,

    SelectOption,

    Redirect,

    // a conversation (frames out, pointer and key events back) riding the challenge machinery for expiry, parked job budget,
    // consumer renderer and visible degradation; passive: the adapter watches for the login completing. Exists for custody:
    // the provider declares no credential fields, so no password is typed into our form or rests anywhere in the platform
    LiveView,
}

// what the answer will BE is not implied by the type: an Image is a box at one provider and a tile grid at the next
[JsonConverter(typeof(JsonStringEnumConverter<ChallengeAnswerKind>))]
public enum ChallengeAnswerKind
{
    // first, so the default: a payload omitting the field, or a challenge raised before this kind existed, keeps its meaning
    Text,

    // points tapped on the relayed image (TapAnswer): the human, not us, solves it
    Taps,
}

// the platform owns redaction, upload, webhook, the consumer's UI and the answer coming back
public sealed record Challenge
{
    public required ChallengeType Type { get; init; }

    // defaults to Text; a consumer that ignores it gets a text box that TapAnswer.TryParse refuses (harmless), whereas
    // inferring taps from any returned string would click a live page at coordinates no human chose
    [JsonPropertyName("answer_kind")]
    public ChallengeAnswerKind AnswerKind { get; init; } = ChallengeAnswerKind.Text;

    /// <summary>Consumer-owned copy key. Never prose.</summary>
    [JsonPropertyName("prompt_key")]
    public string? PromptKey { get; init; }

    // mandatory: a challenge holds a live browser, so a stale one must fail the job and release its agent, not pin it
    [JsonPropertyName("expires_at")]
    public required DateTimeOffset ExpiresAt { get; init; }

    public string? Code { get; init; }

    /// <summary>For <see cref="ChallengeType.MfaCode"/>: <c>sms</c>, <c>totp</c>, <c>email</c>, <c>app</c>.</summary>
    public string? Delivery { get; init; }

    public int? Length { get; init; }

    public IReadOnlyList<ChallengeOption>? Options { get; init; }

    public string? Url { get; init; }

    // the pattern the human's browser is sent to but cannot open, e.g. appie://login-exit*
    [JsonPropertyName("return_pattern")]
    public string? ReturnPattern { get; init; }

    // PNG bytes, already redacted; never populated while a secret field holds content (ScreenshotRedactor)
    [JsonIgnore]
    public byte[]? Image { get; init; }

    // everything outside the region is obscured before the image leaves the agent
    [JsonIgnore]
    public CropRegion? Crop { get; init; }

    public bool IsExpired(DateTimeOffset now) => ExpiresAt <= now;

    [JsonIgnore]
    public bool IsPassive => Type is ChallengeType.AppApproval or ChallengeType.LiveView;
}

public sealed record ChallengeOption
{
    public required string Value { get; init; }

    public required string Label { get; init; }
}

public readonly record struct CropRegion(int X, int Y, int Width, int Height);

// NORMALISED coordinates (fraction of the image, never pixels): the agent captures at the device scale factor and the
// client renders at its own size, so a pixel measured on the client's copy lands in the wrong square
public readonly record struct Tap
{
    // the wire's precision (1/10 000), pinned so a formatted tap round-trips equal to its parsed value
    private const int Digits = 4;

    public Tap(double x, double y)
    {
        X = Normalised(x);
        Y = Normalised(y);
    }

    /// <summary>0 is the image's left edge, 1 its right.</summary>
    public double X { get; }

    /// <summary>0 is the image's top edge, 1 its bottom.</summary>
    public double Y { get; }

    // lives here so the mapping cannot disagree with the encoding: the crop's origin is part of the meaning;
    // for a whole page pass new CropRegion(0, 0, w, h)
    public (double X, double Y) ToPagePixels(CropRegion region) =>
        (region.X + (X * region.Width), region.Y + (Y * region.Height));

    internal string Format() => string.Create(CultureInfo.InvariantCulture, $"{X:0.####},{Y:0.####}");

    private static double Normalised(double value, [CallerArgumentExpression(nameof(value))] string? name = null)
    {
        // a range test doubles as the NaN check: every comparison against NaN is false, so NaN is rejected
        if (value is not (>= 0 and <= 1))
        {
            throw new ArgumentOutOfRangeException(name, value,
                "a tap is a fraction of the relayed image, so each coordinate must be within 0..1");
        }

        return Math.Round(value, Digits, MidpointRounding.AwayFromZero);
    }
}

// frozen on both sides: the list is ordered, as a human made the taps; "submit" is a terminal marker in the same answer,
// since a bare list cannot say "nothing matches" (verify pressed with nothing selected) and a separate submit round
// would double relay latency while a captcha token goes stale
public sealed record TapAnswer
{
    // marks a tap answer inside a field that also carries SMS codes and redirect URLs; versioned for a second grammar
    public const string Prefix = "tap.v1:";

    private const string SubmitMarker = "submit";

    private const char Separator = ';';

    // ordered; empty is a real answer, not a missing one (see Submit)
    public IReadOnlyList<Tap> Taps { get; init; } = [];

    /// <summary>
    /// True when the human is done and the page's verify control should be
    /// pressed after the taps are replayed.
    /// </summary>
    public bool Submit { get; init; }

    public string Format()
    {
        var builder = new StringBuilder(Prefix);

        for (var i = 0; i < Taps.Count; i++)
        {
            if (i > 0) builder.Append(Separator);
            builder.Append(Taps[i].Format());
        }

        if (Submit)
        {
            if (Taps.Count > 0) builder.Append(Separator);
            builder.Append(SubmitMarker);
        }

        return builder.ToString();
    }

    // strict on purpose: a lenient parser would turn a producer's format error into clicks; false means "not a tap answer",
    // e.g. a text answer from a consumer that ignored AnswerKind
    public static bool TryParse(string? value, [NotNullWhen(true)] out TapAnswer? answer)
    {
        answer = null;
        if (value is null) return false;

        var text = value.Trim();
        if (!text.StartsWith(Prefix, StringComparison.Ordinal)) return false;

        var taps = new List<Tap>();
        var submit = false;
        var payload = text[Prefix.Length..].Trim();

        if (payload.Length > 0)
        {
            foreach (var part in payload.Split(Separator))
            {
                if (!TryTakePart(part, taps, ref submit)) return false;
            }
        }

        answer = new TapAnswer { Taps = taps, Submit = submit };
        return true;
    }

    private static bool TryTakePart(string part, List<Tap> taps, ref bool submit)
    {
        // a tap after the marker can no longer reach the page, so the producer is wrong about the format
        if (submit) return false;

        var token = part.Trim();
        if (string.Equals(token, SubmitMarker, StringComparison.Ordinal))
        {
            submit = true;
            return true;
        }

        var point = token.Split(',');
        if (point.Length != 2) return false;
        if (!TryCoordinate(point[0], out var x) || !TryCoordinate(point[1], out var y)) return false;

        taps.Add(new Tap(x, y));
        return true;
    }

    // invariant culture always: half of Europe writes 0,5, and a locale-formatted coordinate would be rejected or misparsed
    private static bool TryCoordinate(string token, out double value) =>
        double.TryParse(token.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out value)
        && value is >= 0 and <= 1;
}

public sealed record ChallengeAnswer
{
    [JsonPropertyName("challenge_id")]
    public required string ChallengeId { get; init; }

    // empty for a passive challenge. A string for every kind, so the wire shape does not change per kind: "" is no answer,
    // "tap.v1:" is an answer with no taps
    public string Value { get; init; } = string.Empty;
}
