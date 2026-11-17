using System.Globalization;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Browsing;

internal readonly record struct LiveViewWindow
{
    public required TimeSpan Elapsed { get; init; }

    public required int Posted { get; init; }

    /// <summary>Frames whose bytes were identical to the last posted frame.</summary>
    public required int Suppressed { get; init; }

    /// <summary>Frames dropped at the source while a navigation was being checked.</summary>
    public required int Missed { get; init; }

    /// <summary>Frames the browser drew that a newer one replaced before they could leave.</summary>
    public required int Superseded { get; init; }

    public required int Failed { get; init; }

    /// <summary>How old a frame was when it left: from the compositor drawing it to the post starting.</summary>
    public required double AgeMedian { get; init; }

    public required double AgeP95 { get; init; }

    public required double PostMedian { get; init; }

    public required double PostP95 { get; init; }

    public required int MeanBytes { get; init; }

    // posted frames only (a suppressed frame is not received): deliberately pessimistic, a static form delivers nothing
    public double Fps => Elapsed.TotalSeconds <= 0 ? 0 : Posted / Elapsed.TotalSeconds;

    public double DrawnHz =>
        Elapsed.TotalSeconds <= 0 ? 0 : (Posted + Suppressed + Missed + Superseded + Failed) / Elapsed.TotalSeconds;

    public double KilobytesPerSecond => Elapsed.TotalSeconds <= 0 ? 0 : Posted * MeanBytes / Elapsed.TotalSeconds / 1024;

    // a window of nothing (a still page, a session's last call) must not log zeroes: that reads as "delivered nothing"
    public bool HasSamples => Posted + Suppressed + Missed + Superseded + Failed > 0;

    public override string ToString() => string.Create(
        CultureInfo.InvariantCulture,
        $"{Fps:0.0} fps delivered of {DrawnHz:0.0} drawn/s, " +
        $"age {AgeMedian:0.0}/{AgeP95:0.0} ms (median/p95), " +
        $"post {PostMedian:0.0}/{PostP95:0.0} ms, " +
        $"{MeanBytes} B/frame, {KilobytesPerSecond:0.0} KB/s, " +
        $"{Posted} posted, {Superseded} superseded, {Suppressed} unchanged, {Missed} withheld, {Failed} refused");
}

// reports at least once a second, not at the end: a killed session would report nothing, and a mid-run degradation
// hides in one average; age (agent machine, pacing) and post (control-plane link) are separate: different people fix them
// not thread-safe: one picture loop writes, the session reads after it finishes
internal sealed class LiveViewMeter(TimeProvider time, TimeSpan interval)
{
    private readonly List<double> _ages = [];
    private readonly List<double> _posts = [];
    private readonly long _openedAt = time.GetTimestamp();

    private long _windowStartedAt = time.GetTimestamp();
    private int _posted;
    private int _suppressed;
    private int _missed;
    private int _superseded;
    private int _failed;
    private long _bytes;

    private int _totalPosted;
    private int _totalSuppressed;
    private int _totalSuperseded;
    private long _totalBytes;

    public void Posted(TimeSpan age, TimeSpan post, int bytes)
    {
        _ages.Add(age.TotalMilliseconds);
        _posts.Add(post.TotalMilliseconds);
        _posted++;
        _totalPosted++;
        _bytes += bytes;
        _totalBytes += bytes;
    }

    public void Suppressed(TimeSpan age)
    {
        _ages.Add(age.TotalMilliseconds);
        _suppressed++;
        _totalSuppressed++;
    }

    public void Missed(int count)
    {
        _missed += count;
    }

    public void Superseded(int count)
    {
        _superseded += count;
        _totalSuperseded += count;
    }

    public void Failed(TimeSpan age)
    {
        _ages.Add(age.TotalMilliseconds);
        _failed++;
    }

    // reading RESETS the window: a caller that reads without logging throws the numbers away, so the session logs on non-null
    public LiveViewWindow? TryClose()
    {
        var elapsed = time.GetElapsedTime(_windowStartedAt);
        if (elapsed < interval) return null;

        return Close(elapsed);
    }

    public LiveViewWindow Close() => Close(time.GetElapsedTime(_windowStartedAt));

    public string Total() => string.Create(
        CultureInfo.InvariantCulture,
        $"{_totalPosted} frame(s) over {time.GetElapsedTime(_openedAt).TotalSeconds:0.0} s, " +
        $"{_totalSuperseded} superseded and {_totalSuppressed} unchanged and not sent, {_totalBytes / 1024} KB total");

    private LiveViewWindow Close(TimeSpan elapsed)
    {
        var window = new LiveViewWindow
        {
            Elapsed = elapsed,
            Posted = _posted,
            Suppressed = _suppressed,
            Missed = _missed,
            Superseded = _superseded,
            Failed = _failed,
            AgeMedian = Percentile(_ages, 0.5),
            AgeP95 = Percentile(_ages, 0.95),
            PostMedian = Percentile(_posts, 0.5),
            PostP95 = Percentile(_posts, 0.95),
            MeanBytes = _posted == 0 ? 0 : (int)(_bytes / _posted),
        };

        _ages.Clear();
        _posts.Clear();
        _posted = 0;
        _suppressed = 0;
        _missed = 0;
        _superseded = 0;
        _failed = 0;
        _bytes = 0;
        _windowStartedAt = time.GetTimestamp();

        return window;
    }

    // nearest-rank on a sorted copy: a window holds a couple of dozen samples, so exact beats an approximation
    private static double Percentile(List<double> samples, double fraction)
    {
        if (samples.Count == 0) return 0;

        var sorted = samples.ToArray();
        Array.Sort(sorted);

        var rank = (int)Math.Ceiling(fraction * sorted.Length) - 1;
        return sorted[Math.Clamp(rank, 0, sorted.Length - 1)];
    }
}

internal static class LiveViewMeterLog
{
    public static void Report(this ILogger logger, string jobId, LiveViewWindow window) =>
        logger.LogInformation("job {JobId}: live view {Window}", jobId, window.ToString());
}
