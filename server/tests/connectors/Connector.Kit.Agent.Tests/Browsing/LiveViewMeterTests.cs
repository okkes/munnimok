using System.Globalization;
using Connector.Kit.Agent.Browsing;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// The measurement itself, because a number nobody can trust is worse than no
/// number: it would be quoted in a decision.
/// </summary>
public class LiveViewMeterTests
{
    [Fact]
    public void A_window_holds_the_median_and_the_p95_of_what_it_was_given()
    {
        var meter = new LiveViewMeter(TimeProvider.System, TimeSpan.Zero);

        // Twenty samples so the 95th percentile has somewhere to land: with
        // nearest-rank it is the 19th of 20, which is the second worst.
        for (var i = 1; i <= 20; i++)
        {
            meter.Posted(TimeSpan.FromMilliseconds(i), TimeSpan.FromMilliseconds(i * 2), bytes: 1000);
        }

        var window = meter.Close();

        Assert.Equal(20, window.Posted);
        Assert.Equal(10, window.AgeMedian);
        Assert.Equal(19, window.AgeP95);
        Assert.Equal(20, window.PostMedian);
        Assert.Equal(38, window.PostP95);
        Assert.Equal(1000, window.MeanBytes);
    }

    /// <summary>
    /// What the browser drew and never had to send is counted beside what was
    /// sent, so a window says how much the pacing kept off the wire - and a
    /// window in which only that happened is still a window worth writing down.
    /// </summary>
    [Fact]
    public void Frames_that_never_left_are_counted_beside_those_that_did()
    {
        var meter = new LiveViewMeter(TimeProvider.System, TimeSpan.Zero);

        meter.Superseded(7);
        meter.Missed(2);
        var window = meter.Close();

        Assert.True(window.HasSamples);
        Assert.Equal(0, window.Posted);
        Assert.Equal(7, window.Superseded);
        Assert.Equal(2, window.Missed);
        Assert.Contains("7 superseded", window.ToString(), StringComparison.Ordinal);
        Assert.Contains("2 withheld", window.ToString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// Closing a window empties it, so the next second's numbers are the next
    /// second's. A meter that accumulated forever would report an average over
    /// the whole login, in which a cadence that fell apart halfway through is
    /// invisible - which is the reason it reports every second at all.
    /// </summary>
    [Fact]
    public void Closing_a_window_starts_a_new_one()
    {
        var meter = new LiveViewMeter(TimeProvider.System, TimeSpan.Zero);

        meter.Posted(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(5), bytes: 1000);
        Assert.True(meter.Close().HasSamples);

        Assert.False(meter.Close().HasSamples);
    }

    /// <summary>
    /// A window with nothing in it says so, so the session does not print a
    /// line of zeroes under a still page or a stream that had just reported a
    /// good second.
    /// </summary>
    [Fact]
    public void An_empty_window_reports_that_it_is_empty()
    {
        Assert.False(new LiveViewMeter(TimeProvider.System, TimeSpan.Zero).Close().HasSamples);
    }

    /// <summary>
    /// The numbers are formatted invariantly, wherever the agent is running.
    ///
    /// Half of Europe writes <c>0,5</c>, and this agent's own locale is
    /// configurable to match the provider it is pretending to be a customer of.
    /// A log line that reported <c>4,9 fps</c> is a log line nobody can grep and
    /// no dashboard can parse.
    /// </summary>
    [Fact]
    public void The_numbers_read_the_same_in_every_locale()
    {
        var original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("nl-NL");

            var meter = new LiveViewMeter(TimeProvider.System, TimeSpan.Zero);
            meter.Posted(TimeSpan.FromMilliseconds(12.5), TimeSpan.FromMilliseconds(3.4), bytes: 8000);

            var line = meter.Close().ToString();

            Assert.Contains("age 12.5/12.5 ms", line, StringComparison.Ordinal);
            Assert.Contains("post 3.4/3.4 ms", line, StringComparison.Ordinal);
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }
}
