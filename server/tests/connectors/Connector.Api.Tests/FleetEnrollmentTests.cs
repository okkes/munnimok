using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Auth;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// Connector:FleetEnrollmentCode: a standing, reusable code for the operator's pooled agent, allowed in production
// because it is a platform secret, not a line in a checked-in compose file
[Collection(ShopApiCollection.Name)]
public sealed class FleetEnrollmentTests(ShopApiFactory factory)
{
    [Fact]
    public async Task The_fleet_code_enrolls_the_fleet_subject_and_survives_being_redeemed()
    {
        var code = $"AGNT-FLEE-{Guid.NewGuid():N}"[..24];

        await SeedAsync(code);
        var first = await RedeemAsync(code);

        // the agent's state volume and the control plane's database are two volumes: re-arming on every start lets an agent
        // with a wiped state file come back with the same platform secret
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

        var listed = new ConnectorOptions { FleetEnrollmentCode = "AGNT-FLEE-T000", FleetSubjects = ["ops", ConnectorOptions.FleetSubject] };
        Assert.Equal(["ops", ConnectorOptions.FleetSubject], listed.EffectiveFleetSubjects);
        Assert.True(listed.IsFleet("ops"));
    }

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

    // a private slot (#420 A2) enrolled with the fleet's code would be the fleet: start-up refuses it in every mode
    [Fact]
    public void The_private_slot_code_may_not_be_the_fleet_code()
    {
        var same = new ConnectorOptions { FleetEnrollmentCode = "AGNT-SAME-0000", PrivateEnrollmentCode = "AGNT-SAME-0000" };
        var refusal = Assert.ThrowsAny<Exception>(() => ConnectorPlatform.Validate(same));
        Assert.Contains("PrivateEnrollmentCode", refusal.Message, StringComparison.Ordinal);

        ConnectorPlatform.Validate(new ConnectorOptions { FleetEnrollmentCode = "AGNT-FLEE-0000", PrivateEnrollmentCode = "AGNT-SLOT-0000" });
        ConnectorPlatform.Validate(new ConnectorOptions { PrivateEnrollmentCode = "AGNT-SLOT-0000" });
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
