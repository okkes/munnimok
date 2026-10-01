namespace Connector.Kit.Agent.Tests.Configuration;

/// <summary>
/// One connection is one connector this agent serves. Its name becomes a
/// directory under the profile root and its base address is where every
/// call goes, so both are checked before the agent starts rather than
/// discovered as a crash halfway through an enrollment.
/// </summary>
public sealed class ConnectorConnectionTests
{
    [Fact]
    public void A_complete_connection_has_no_problems_and_a_base_address_that_ends_in_a_slash()
    {
        var connection = new ConnectorConnection
        {
            Name = "munni-dev",
            ControlPlaneBaseUrl = new Uri("https://munni.test/connector"),
        };

        Assert.Empty(connection.Problems());
        Assert.Equal("https://munni.test/connector/", connection.RequireBaseAddress().AbsoluteUri);
        Assert.Equal(Path.Combine("root", "munni-dev"), connection.ProfileRootUnder("root"));
    }

    [Theory]
    [InlineData("", "needs a Name")]
    [InlineData("  ", "needs a Name")]
    [InlineData("-leading-dash", "must be 1-32 letters")]
    [InlineData("has space", "must be 1-32 letters")]
    [InlineData("a-name-that-is-far-too-long-to-be-a-directory", "must be 1-32 letters")]
    public void A_name_that_cannot_be_a_directory_is_a_problem(string name, string expected)
    {
        var connection = new ConnectorConnection { Name = name, ControlPlaneBaseUrl = new Uri("https://munni.test/") };

        var problem = Assert.Single(connection.Problems());

        Assert.Contains(expected, problem, StringComparison.Ordinal);
    }

    [Fact]
    public void A_missing_or_relative_base_address_is_a_problem_and_a_missing_one_cannot_be_required()
    {
        var missing = new ConnectorConnection { Name = "munni" };
        var relative = new ConnectorConnection { Name = "munni", ControlPlaneBaseUrl = new Uri("connector/", UriKind.Relative) };

        Assert.Contains("no ControlPlaneBaseUrl", Assert.Single(missing.Problems()), StringComparison.Ordinal);
        Assert.Contains("not absolute", Assert.Single(relative.Problems()), StringComparison.Ordinal);
        Assert.Throws<InvalidOperationException>(() => missing.RequireBaseAddress());
    }

    [Fact]
    public void A_certificate_authority_that_is_not_on_disk_is_a_problem()
    {
        var connection = new ConnectorConnection
        {
            Name = "munni",
            ControlPlaneBaseUrl = new Uri("https://munni.test/"),
            ControlPlaneCaPath = Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.crt"),
        };

        var problem = Assert.Single(connection.Problems());

        Assert.Contains("there is no file there", problem, StringComparison.Ordinal);
    }
}
