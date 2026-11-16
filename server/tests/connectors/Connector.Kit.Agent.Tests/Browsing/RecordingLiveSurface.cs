using System.Globalization;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Challenges;

namespace Connector.Kit.Agent.Tests;

/// records instead of acting: an event that must not happen must not happen AT ALL, which a counting stub cannot show
/// PressAsync records the ENUM: the seam takes it so no relayed string reaches Playwright
internal sealed class RecordingLiveSurface : ILiveSurface
{
    /// the only way to assert "moved BEFORE it pressed"
    public List<string> Trace { get; } = [];

    public List<(double X, double Y)> Moves { get; } = [];

    public List<LiveKey> Keys { get; } = [];

    /// the typed text itself: only a test may hold this
    public List<string> Texts { get; } = [];

    public List<double> Scrolls { get; } = [];

    /// <summary>Set to throw from the next call of a given kind, to prove a batch stops.</summary>
    public string? FailOn { get; set; }

    public Task MoveAsync(double x, double y, CancellationToken ct)
    {
        Moves.Add((x, y));
        Trace.Add(FormattableString.Invariant($"move {x},{y}"));
        return Fail("move");
    }

    public Task DownAsync(CancellationToken ct)
    {
        Trace.Add("down");
        return Fail("down");
    }

    public Task UpAsync(CancellationToken ct)
    {
        Trace.Add("up");
        return Fail("up");
    }

    public Task ScrollAsync(double deltaY, CancellationToken ct)
    {
        Scrolls.Add(deltaY);
        Trace.Add(FormattableString.Invariant($"scroll {deltaY}"));
        return Fail("scroll");
    }

    public Task TypeTextAsync(string text, CancellationToken ct)
    {
        Texts.Add(text);

        // The length and never the value, so a failing test cannot print
        // somebody's password into a build log.
        Trace.Add(string.Create(CultureInfo.InvariantCulture, $"text[{text.Length}]"));
        return Fail("text");
    }

    public Task PressAsync(LiveKey key, CancellationToken ct)
    {
        Keys.Add(key);
        Trace.Add("key " + key);
        return Fail("key");
    }

    public List<Uri> Navigations { get; } = [];

    public Task NavigateAsync(Uri url, CancellationToken ct)
    {
        Navigations.Add(url);
        Trace.Add("navigate " + url);
        return Fail("navigate");
    }

    public Task BackAsync(CancellationToken ct)
    {
        Trace.Add("back");
        return Fail("back");
    }

    public Task ReloadAsync(CancellationToken ct)
    {
        Trace.Add("reload");
        return Fail("reload");
    }

    private Task Fail(string what) =>
        string.Equals(FailOn, what, StringComparison.Ordinal)
            ? Task.FromException(new Microsoft.Playwright.PlaywrightException("the page went away"))
            : Task.CompletedTask;
}
