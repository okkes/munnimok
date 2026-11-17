using System.Globalization;
using System.Text.RegularExpressions;

namespace Connector.Kit.Agent.Tests.Deployment;

/// StopAsync takes 28 s on defaults (drain plus abort grace); Docker's 10 s SIGKILLs a Chromium with the profile
/// open, which is the bank session the file exists to keep: the compose file's 45s must not be trimmed
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

    /// the file check passes on a 45s written anywhere; this reads what each live service ends up with, and a service-level
    /// stop_grace_period beats a shared one. One window suffices: the machine runs one job in total, so one browser to drain
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

    /// read off the options: a test with its own copy would pass when they moved
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

    [GeneratedRegex(@"^(?<seconds>[0-9]+)s$")]
    private static partial Regex WholeSeconds();
}
