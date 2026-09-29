using System.Globalization;
using System.Text.RegularExpressions;

namespace Connector.Kit.Agent.Tests.Deployment;

/// <summary>
/// The BYO container is given long enough to stop the way the agent stops.
///
/// <para>
/// <c>AgentHost.StopAsync</c> drains in-flight jobs for
/// <c>ShutdownDrainTimeout</c> and then gives aborted ones
/// <c>ShutdownAbortGrace</c> to report upstream - twenty-eight seconds on
/// the defaults. Docker's own grace is ten, after which it SIGKILLs the
/// process: for this container that is a Chromium killed with the profile
/// open, and the profile is the bank session the whole file exists to keep.
/// The compose file says 45s; this is what stops somebody trimming it back
/// to a number that looks tidier and is eighteen seconds too short.
/// </para>
/// </summary>
public sealed partial class ByoAgentStopGraceTests
{
    [Fact]
    public void The_BYO_container_waits_at_least_as_long_as_the_agent_takes_to_stop()
    {
        var compose = File.ReadAllText(ByoCompose.FilePath);

        var match = StopGrace().Match(compose);
        Assert.True(match.Success, "deploy/byo/docker-compose.yml sets no stop_grace_period; Docker's is 10s");

        var grace = TimeSpan.FromSeconds(int.Parse(match.Groups["seconds"].Value, CultureInfo.InvariantCulture));

        Assert.True(
            grace >= Needed,
            $"stop_grace_period is {grace.TotalSeconds}s and the agent's drain plus abort grace is "
            + $"{Needed.TotalSeconds}s; Docker would SIGKILL a Chromium mid-drain with the profile open");
    }

    /// <summary>
    /// And no service quietly takes it back.
    /// </summary>
    /// <remarks>
    /// The check above reads the FILE: it passes on a 45s written anywhere,
    /// including one in a comment or on a service that is not the one running.
    /// This reads what each live service ends up with, which is the number
    /// Docker actually uses - a <c>stop_grace_period</c> written inside a
    /// service beats a shared one, and the file's own footer tells people how
    /// to copy the service block for a second account at one provider, which
    /// is the copy that arrives without it.
    /// <para>
    /// One window is enough for every connector, and that is a property of the
    /// change rather than luck: the machine runs one job in total rather than
    /// one per connector, so there is never more than one browser to drain.
    /// </para>
    /// </remarks>
    [Fact]
    public void No_service_shortens_the_grace_it_inherits()
    {
        var compose = ByoCompose.Read();
        Assert.NotEmpty(compose.Services);

        foreach (var service in compose.Services)
        {
            Assert.True(
                service.Effective.TryGetValue("stop_grace_period", out var written),
                $"service {service.Name} ends up with no stop_grace_period at all; Docker's is 10s");

            var match = WholeSeconds().Match(written!);
            Assert.True(match.Success, $"service {service.Name} stops on '{written}', which is not whole seconds");

            var grace = TimeSpan.FromSeconds(int.Parse(match.Groups["seconds"].Value, CultureInfo.InvariantCulture));

            Assert.True(
                grace >= Needed,
                $"service {service.Name} stops on {grace.TotalSeconds}s and the agent needs "
                + $"{Needed.TotalSeconds}s to drain and report");
        }
    }

    /// <summary>
    /// Read off the options rather than restated: the numbers are the agent's,
    /// and a test carrying its own copy would pass when they moved.
    /// </summary>
    private static TimeSpan Needed
    {
        get
        {
            var defaults = new ConnectorAgentOptions();
            return defaults.ShutdownDrainTimeout + defaults.ShutdownAbortGrace;
        }
    }

    /// <summary>An uncommented <c>stop_grace_period: 45s</c>, in whole seconds.</summary>
    [GeneratedRegex(@"^\s*stop_grace_period:\s*(?<seconds>[0-9]+)s\s*$", RegexOptions.Multiline)]
    private static partial Regex StopGrace();

    /// <summary>The value on its own - <c>45s</c> - as a merged service carries it.</summary>
    [GeneratedRegex(@"^(?<seconds>[0-9]+)s$")]
    private static partial Regex WholeSeconds();
}
