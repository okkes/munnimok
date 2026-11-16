using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json.Serialization;

namespace Connector.Kit.Challenges;

// the whole vocabulary on purpose: nothing here carries a URL, selector, script or file path, so navigation, evaluation
// and upload are unsayable; the agent also bounds a pointer to the streamed rectangle and refuses keys outside LiveKey.
// Weaker than the tap grammar was: it buys back only what a login needs
[JsonConverter(typeof(JsonStringEnumConverter<LiveInputKind>))]
public enum LiveInputKind
{
    Move,

    /// <summary>Primary button pressed. There is no secondary button on purpose - see the class remarks.</summary>
    Down,

    Up,

    /// <summary>A wheel or a swipe, in fractions of the view.</summary>
    Scroll,

    Text,

    /// <summary>One of the named keys. Never a chord, never a modifier held down.</summary>
    Key,

    // #441 L3: the operator's vocabulary: the control plane refuses it except on an explore run, and the agent dispatches
    // it only on a live view opened with navigation allowed; the address is held to ExploreProvider.IsNavigable
    Navigate,

    /// <summary>One step back in the browser's history. Explore runs only.</summary>
    Back,

    /// <summary>Reload the page. Explore runs only.</summary>
    Reload,
}

// closed and short: PressAsync reads a STRING like "Control+o" as a chord and DownAsync latches a modifier that a click
// picks up, so no relayed value reaches PressAsync: the enum maps to a literal and no key is ever held down
[JsonConverter(typeof(JsonStringEnumConverter<LiveKey>))]
public enum LiveKey
{
    Backspace,
    Delete,
    Enter,
    Tab,
    Escape,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
}

// fractions, not pixels: the human's screen and the agent's viewport differ in size; a fraction survives rotation mid-login
public sealed record LiveInput
{
    public required LiveInputKind Kind { get; init; }

    /// <summary>0 at the left edge of the picture, 1 at the right. Ignored by Text and Key.</summary>
    public double X { get; init; }

    /// <summary>0 at the top edge, 1 at the bottom. Ignored by Text and Key.</summary>
    public double Y { get; init; }

    // never logged; delivered with Playwright's InsertText, so literal characters and never a key name
    public string? Text { get; init; }

    public LiveKey? Key { get; init; }

    public string? Url { get; init; }

    /// <summary>For <see cref="LiveInputKind.Scroll"/>: fractions of the view to travel.</summary>
    public double DeltaY { get; init; }

    // the consumer's counter, so the agent can drop a duplicate and reorder: an unreliable phone connection does both
    public long Sequence { get; init; }

    // refuses coordinates outside the picture rather than clamping: a clamped tap is a click the human did not choose
    public bool IsWellFormed()
    {
        // the kind is checked first: the enum converter accepts an integer, so "kind": 99 once reached the dispatch switch's
        // unreachable default and faulted the replay loop for the rest of the login
        if (!System.Enum.IsDefined(Kind)) return false;

        if (Kind is LiveInputKind.Text)
        {
            return !string.IsNullOrEmpty(Text) && Text.Length <= MaxTextLength && !HasControlCharacters(Text);
        }

        if (Kind is LiveInputKind.Key) return Key is not null && System.Enum.IsDefined(Key.Value);

        if (Kind is LiveInputKind.Navigate) return Exploring.ExploreProvider.IsNavigable(Url, out _);

        if (Kind is LiveInputKind.Back or LiveInputKind.Reload) return true;

        if (Kind is LiveInputKind.Scroll) return IsFraction(X) && IsFraction(Y) && double.IsFinite(DeltaY);

        return IsFraction(X) && IsFraction(Y);
    }

    // a paste is one event, a held key is not: long enough for a password manager, too short to smuggle through as one key
    public const int MaxTextLength = 256;

    private static bool IsFraction(double value) => double.IsFinite(value) && value is >= 0 and <= 1;

    // control characters turn typed text into something else (a newline that submits, escapes in a log pipeline); Enter is a key
    private static bool HasControlCharacters(string text) => text.Any(char.IsControl);
}

// a batch: one event per request spends more time in HTTP headers than in the browser, and a drag is thirty moves
public sealed record LiveInputBatch
{
    /// <summary>In the order the human made them; the agent replays them in that order.</summary>
    public IReadOnlyList<LiveInput> Events { get; init; } = [];

    // bounds one request so a batch cannot keep an agent busy indefinitely
    public const int MaxEvents = 64;

    public bool IsWellFormed() =>
        Events.Count is > 0 and <= MaxEvents && Events.All(e => e.IsWellFormed());

    /// <summary>Whether any event moves the browser itself (#441 L3): allowed on an explore run and nowhere else.</summary>
    public bool Navigates() =>
        Events.Any(e => e.Kind is LiveInputKind.Navigate or LiveInputKind.Back or LiveInputKind.Reload);
}

// the size travels with the bytes: the consumer needs it to turn a tap into a fraction, and a provider re-rendering
// at another size mid-login would otherwise misplace every event silently
public sealed record LiveFrame
{
    // monotonic per JOB, not per session: the connector keeps one slot per job and refuses a frame not higher than the one
    // held, so an agent counting from zero per live view had a second view's frames silently discarded (answered 200)
    public required long Sequence { get; init; }

    public required int Width { get; init; }

    public required int Height { get; init; }

    // JPEG, never PNG: a captcha with a picture is 14 KB as JPEG and 194 KB as PNG, and the stream must survive its worst
    // frame (a flat login form is smaller as PNG: 6.3 vs 9.1 KB)
    public required byte[] Bytes { get; init; }

    // whose page this is, e.g. https://login.ah.nl; null reads as "unknown", never "fine". The only anti-phishing cue of a
    // streamed login (no address bar); per FRAME because a login navigates; origin, never URL: queries carry tokens
    public string? Origin { get; init; }
}

// here because both ends normalise and must not disagree: the control plane cannot assume another process checked a header
public static class LiveOrigin
{
    // DNS bounds a host at 253 characters, so anything past this is not a hostname
    public const int MaxLength = 300;

    // bounds the INPUT url, separate from MaxLength (the origin): an OAuth authorize URL (Lidl's) passes 300 chars, and
    // bounding the input at 300 lost the origin on exactly the pages that need it most
    public const int MaxUrlLength = 8_192;

    // null must reach the human as "unknown", never something reassuring. Origin only (a query can carry a token); http(s) only.
    // punycode, because a Cyrillic а in https://аh.nl is indistinguishable from the real host as unicode
    public static string? Normalize(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || url.Length > MaxUrlLength) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return null;
        if (parsed.Scheme is not ("http" or "https")) return null;
        if (string.IsNullOrEmpty(parsed.IdnHost)) return null;

        var origin = parsed.IsDefaultPort
            ? string.Concat(parsed.Scheme, "://", parsed.IdnHost)
            : string.Concat(parsed.Scheme, "://", parsed.IdnHost, ":", parsed.Port.ToString(CultureInfo.InvariantCulture));

        return origin.Length > MaxLength ? null : origin;
    }
}
