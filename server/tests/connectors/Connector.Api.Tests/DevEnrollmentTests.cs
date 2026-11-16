using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Auth;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// the dev code is fixed, reusable and ten years long so a compose-file agent enrols unattended: it must survive restarts
/// and wiped volumes, and must never be present in production
[Collection(ShopApiCollection.Name)]
public sealed class DevEnrollmentTests(ShopApiFactory factory)
{
    [Fact]
    public async Task The_development_code_survives_being_redeemed()
    {
        var code = $"AGNT-DEV0-{Guid.NewGuid():N}"[..24];

        await SeedAsync(code);
        var first = await RedeemAsync(code);

        // agent state and control-plane database are separate volumes: clearing either sends the agent back to enrollment
        // with a code a one-time rule would already have spent
        await SeedAsync(code);
        var second = await RedeemAsync(code);

        Assert.Equal(ConnectorOptions.DevFleetSubject, first.Subject);
        Assert.Equal(ConnectorOptions.DevFleetSubject, second.Subject);
    }

    /// re-seeding makes it reusable; a single seed redeems once like any code, so dev and real paths share rules
    [Fact]
    public async Task One_seeding_is_still_only_one_redemption()
    {
        var code = $"AGNT-ONCE-{Guid.NewGuid():N}"[..24];

        await SeedAsync(code);
        await RedeemAsync(code);

        await Assert.ThrowsAnyAsync<Exception>(() => RedeemAsync(code));
    }

    [Fact]
    public void A_production_connector_refuses_to_start_carrying_a_development_enrollment_code()
    {
        var failure = Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddConnectorPlatform(Production(devCode: "AGNT-DEV0-LOCAL")));

        Assert.Contains("Connector:DevEnrollmentCode", failure.Message, StringComparison.Ordinal);
    }

    /// without the code it must fail for its OTHER reasons, else the test above passes against a check that refuses everything
    [Fact]
    public void A_production_connector_without_one_is_not_refused_for_this_reason()
    {
        var failure = Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddConnectorPlatform(Production(devCode: null)));

        Assert.DoesNotContain("Connector:DevEnrollmentCode", failure.Message, StringComparison.Ordinal);
    }

    private static IConfiguration Production(string? devCode)
    {
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Connector:Mode"] = "Production",
        };

        if (devCode is not null) settings["Connector:DevEnrollmentCode"] = devCode;

        return new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
    }

    private async Task SeedAsync(string code)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AgentAuth>()
            .SeedDevEnrollmentAsync(code, CancellationToken.None);
    }

    private async Task<Connector.Kit.Hosting.Data.EnrollmentRow> RedeemAsync(string code)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AgentAuth>()
            .RedeemEnrollmentAsync(code, CancellationToken.None);
    }
}
