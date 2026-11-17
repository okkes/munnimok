using Connector.Kit.Agent.Browsing;

namespace Connector.Kit.Agent.Tests;

/// a click that should not happen must not happen at all, which a stub that only counts cannot show
internal sealed class RecordingPointer : IPointerSurface
{
    public List<(double X, double Y)> Clicks { get; } = [];

    public List<TimeSpan> Pauses { get; } = [];

    /// <summary>
    /// Clicks and pauses interleaved. The only way to say "between the taps"
    /// rather than merely "as many pauses as taps, minus one".
    /// </summary>
    public List<string> Trace { get; } = [];

    public Task ClickAsync(double x, double y, CancellationToken ct)
    {
        Clicks.Add((x, y));
        Trace.Add(FormattableString.Invariant($"click {x},{y}"));
        return Task.CompletedTask;
    }

    public Task PauseAsync(TimeSpan gap, CancellationToken ct)
    {
        Pauses.Add(gap);
        Trace.Add(FormattableString.Invariant($"pause {gap.TotalMilliseconds}"));
        return Task.CompletedTask;
    }
}
