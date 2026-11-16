using Connector.Kit.Hosting;

namespace Connector.Api.Tests;

// DevEnrollmentCode must not exist in production: a fixed, never-expiring code written in a compose file is a
// password that enrolls agents leasing real jobs; asserted to fire, not trusted
public sealed class ProductionRefusalTests
{
    /// <summary>
    /// Everything production demands, so a test about ONE missing thing is
    /// about that thing and not about the pile underneath it.
    /// </summary>
    private static ConnectorOptions Sound()
    {
        var options = new ConnectorOptions { Mode = ConnectorMode.Production };

        options.Bundle.CurrentKid = "k1";
        options.Bundle.Keys["k1"] = Convert.ToBase64String(new byte[32]);
        options.Auth.Authority = "https://issuer.example";
        options.Auth.Audience = "connector";
        options.EnrollmentHmacKey = Convert.ToBase64String(new byte[32]);
        options.Database.Provider = ConnectorDatabaseProvider.Postgres;

        return options;
    }

    // the control: without it a validator refusing everything would pass the suite and fail a deploy
    [Fact]
    public void A_production_configuration_with_everything_it_needs_starts()
    {
        ConnectorPlatform.Validate(Sound());
    }

    [Fact]
    public void A_development_enrollment_code_refuses_to_start_in_production()
    {
        var options = Sound();
        options.DevEnrollmentCode = "AGNT-DEV0-000000000000000";

        var refused = Assert.Throws<InvalidOperationException>(() => ConnectorPlatform.Validate(options));

        Assert.Contains(
            "Connector:DevEnrollmentCode must not be set in production",
            refused.Message,
            StringComparison.Ordinal);
    }

    // refused on its own merits: an unrelated throw would pass the test above
    [Fact]
    public void The_enrollment_code_is_the_only_thing_that_configuration_got_wrong()
    {
        var options = Sound();
        options.DevEnrollmentCode = "AGNT-DEV0-000000000000000";

        var refused = Assert.Throws<InvalidOperationException>(() => ConnectorPlatform.Validate(options));

        Assert.Single(
            refused.Message.Split(Environment.NewLine + "- ", StringSplitOptions.RemoveEmptyEntries).Skip(1));
    }

    [Fact]
    public void A_development_enrollment_code_is_fine_in_development()
    {
        ConnectorPlatform.Validate(new ConnectorOptions
        {
            Mode = ConnectorMode.Development,
            DevEnrollmentCode = "AGNT-DEV0-000000000000000",
        });
    }

    // each is a service that would boot looking healthy while wrong
    [Theory]
    [InlineData("bundle", "Connector:Bundle:CurrentKid and Connector:Bundle:Keys are required in production")]
    [InlineData("authority", "Connector:Auth:Authority is required in production")]
    [InlineData("audience", "Connector:Auth:Audience is required in production")]
    [InlineData("hmac", "Connector:EnrollmentHmacKey is required in production")]
    [InlineData("database", "Connector:Database:Provider must be 'postgres' in production")]
    public void Production_refuses_to_start_without(string what, string expected)
    {
        var options = Sound();

        switch (what)
        {
            case "bundle": options.Bundle.Keys.Clear(); options.Bundle.CurrentKid = null; break;
            case "authority": options.Auth.Authority = null; break;
            case "audience": options.Auth.Audience = null; break;
            case "hmac": options.EnrollmentHmacKey = null; break;
            case "database": options.Database.Provider = ConnectorDatabaseProvider.Sqlite; break;
            default: throw new ArgumentOutOfRangeException(nameof(what), what, "unknown knob");
        }

        var refused = Assert.Throws<InvalidOperationException>(() => ConnectorPlatform.Validate(options));

        Assert.Contains(expected, refused.Message, StringComparison.Ordinal);
    }
}
