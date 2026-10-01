using Connector.Kit.Hosting;

namespace Connector.Api.Tests;

/// <summary>
/// The things a production connector refuses to start without - asserted to
/// actually fire, rather than trusted to.
///
/// <para>
/// <see cref="DevEnrollmentTests"/> opens by naming two properties worth
/// testing about <c>Connector:DevEnrollmentCode</c>: that it survives a restart,
/// and that <b>it cannot be present in production at all</b>. It tests the
/// first. The second was a sentence in a doc comment and a line in a validator,
/// with nothing anywhere establishing that the line runs - which is the same
/// shape as a note explaining that an account list is short while the field
/// beside it says complete.
/// </para>
///
/// <para>
/// This matters more than the average guard. A fixed, reusable, never-expiring
/// enrollment code is a password, and the one this option exists for is written
/// in a compose file in this repository. Anything holding it could enroll an
/// agent that leases real jobs and is handed real credentials.
/// </para>
/// </summary>
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

    /// <summary>The control: the sound configuration is accepted.</summary>
    /// <remarks>
    /// Without this, every assertion below would be satisfied by a validator
    /// that refuses everything - which passes a suite and fails a deploy.
    /// </remarks>
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

    /// <summary>
    /// And it is refused on its own merits, not swept up by another problem.
    /// </summary>
    /// <remarks>
    /// A validator that threw for some unrelated reason would satisfy the test
    /// above while leaving the code perfectly usable in a deployment that got
    /// everything else right - which is the deployment this guard is for.
    /// </remarks>
    [Fact]
    public void The_enrollment_code_is_the_only_thing_that_configuration_got_wrong()
    {
        var options = Sound();
        options.DevEnrollmentCode = "AGNT-DEV0-000000000000000";

        var refused = Assert.Throws<InvalidOperationException>(() => ConnectorPlatform.Validate(options));

        Assert.Single(
            refused.Message.Split(Environment.NewLine + "- ", StringSplitOptions.RemoveEmptyEntries).Skip(1));
    }

    /// <summary>
    /// The same code outside production is left alone, because that is what it
    /// is for.
    /// </summary>
    [Fact]
    public void A_development_enrollment_code_is_fine_in_development()
    {
        ConnectorPlatform.Validate(new ConnectorOptions
        {
            Mode = ConnectorMode.Development,
            DevEnrollmentCode = "AGNT-DEV0-000000000000000",
        });
    }

    /// <summary>
    /// The rest of the production floor, each asserted to fire on its own.
    /// </summary>
    /// <remarks>
    /// Every one of these is a service that would boot and look completely
    /// healthy while being wrong: bundle keys that die with the process, an
    /// agent endpoint with no client certificate to check, a token audience
    /// nobody verifies, or a database that vanishes on restart.
    /// </remarks>
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
