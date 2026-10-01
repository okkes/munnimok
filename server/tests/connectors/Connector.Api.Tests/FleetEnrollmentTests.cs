using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Auth;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// <c>Connector:FleetEnrollmentCode</c> is the development code's grown-up
/// sibling: a standing, reusable code that enrolls the operator's own pooled
/// agent — in production too, because it is a platform secret minted and
/// rotated like every other, not a line in a checked-in compose file. The
/// properties worth testing are the ones the platform relies on: it survives
/// a restart and a wiped state, it enrolls the fleet subject and nobody else,
/// that subject IS the fleet without being listed, and production accepts it.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class FleetEnrollmentTests(ShopApiFactory factory)
{
    [Fact]
    public async Task The_fleet_code_enrolls_the_fleet_subject_and_survives_being_redeemed()
    {
        var code = $"AGNT-FLEE-{Guid.NewGuid():N}"[..24];

        await SeedAsync(code);
        var first = await RedeemAsync(code);

        // the agent's state volume and the control plane's database are two
        // volumes; re-arming on every start is what lets a pooled agent with
        // a wiped state file come back with the same platform secret
        await SeedAsync(code);
        var second = await RedeemAsync(code);

        Assert.Equal(ConnectorOptions.FleetSubject, first.Subject);
        Assert.Equal(ConnectorOptions.FleetSubject, second.Subject);
        Assert.Equal("fleet", second.Name);
    }

    [Fact]
    public async Task One_seeding_of_the_fleet_code_is_still_one_redemption()
    {
        var code = $"AGNT-FLE1-{Guid.NewGuid():N}"[..24];

        await SeedAsync(code);
        await RedeemAsync(code);

        await Assert.ThrowsAnyAsync<Exception>(() => RedeemAsync(code));
    }

    [Fact]
    public void The_fleet_codes_subject_is_the_fleet_without_being_listed()
    {
        var bare = new ConnectorOptions();
        Assert.False(bare.IsFleet(ConnectorOptions.FleetSubject));
        Assert.Empty(bare.EffectiveFleetSubjects);

        var withCode = new ConnectorOptions { FleetEnrollmentCode = "AGNT-FLEE-T000" };
        Assert.True(withCode.IsFleet(ConnectorOptions.FleetSubject));
        Assert.False(withCode.IsFleet("u_somebody"));
        Assert.False(withCode.IsFleet(null));
        Assert.Equal([ConnectorOptions.FleetSubject], withCode.EffectiveFleetSubjects);

        // a listed subject stays; the fleet subject is not listed twice
        var listed = new ConnectorOptions { FleetEnrollmentCode = "AGNT-FLEE-T000", FleetSubjects = ["ops", ConnectorOptions.FleetSubject] };
        Assert.Equal(["ops", ConnectorOptions.FleetSubject], listed.EffectiveFleetSubjects);
        Assert.True(listed.IsFleet("ops"));
    }

    /// <summary>The production floor accepts it — the whole point of it existing beside the development code.</summary>
    [Fact]
    public void A_production_configuration_may_carry_a_fleet_enrollment_code()
    {
        var options = new ConnectorOptions { Mode = ConnectorMode.Production, FleetEnrollmentCode = "AGNT-FLEE-T000" };
        options.Bundle.CurrentKid = "k1";
        options.Bundle.Keys["k1"] = Convert.ToBase64String(new byte[32]);
        options.Auth.Authority = "https://issuer.example";
        options.Auth.Audience = "connector";
        options.EnrollmentHmacKey = Convert.ToBase64String(new byte[32]);
        options.Database.Provider = ConnectorDatabaseProvider.Postgres;

        ConnectorPlatform.Validate(options);
    }

    private async Task SeedAsync(string code)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AgentAuth>()
            .SeedStandingEnrollmentAsync(code, ConnectorOptions.FleetSubject, "fleet", CancellationToken.None);
    }

    private async Task<Connector.Kit.Hosting.Data.EnrollmentRow> RedeemAsync(string code)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AgentAuth>()
            .RedeemEnrollmentAsync(code, CancellationToken.None);
    }
}
