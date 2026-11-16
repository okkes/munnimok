using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using RegistryConnector.Adapters;
using RegistryConnector.Adapters.Mock;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// proves a provider that re-authenticates on EVERY sync (six digits from a human each time) is expressible,
// and that consumers are told
public sealed class MockRegistryTests
{
    private static readonly ProviderRegistry Registry =
        new(RegistryAdapters.All());

    [Fact]
    public void Every_registry_manifest_validates_and_is_a_registry()
    {
        Assert.NotEmpty(Registry.Manifests);

        foreach (var manifest in Registry.Manifests)
        {
            ManifestValidator.Validate(manifest);

            Assert.Equal(ProviderKind.Registry, manifest.Kind);
        }
    }

    // a registry states what is true now; `since` would invite a question it cannot answer, whatever the provider
    [Fact]
    public void No_registry_resource_takes_a_date_range()
    {
        var resources = Registry.Manifests.SelectMany(m => m.Resources).ToList();

        // guards the loop: an empty registry would pass by never running
        Assert.NotEmpty(resources);

        foreach (var resource in resources)
        {
            Assert.Null(resource.Param("since"));
            Assert.Null(resource.Param("until"));
        }
    }

    [Fact]
    public void A_credits_resource_returns_credit_registrations()
    {
        var credits = Registry.Manifests
            .Select(m => m.Resource(MockRegistryAdapter.CreditsResource))
            .Where(r => r is not null)
            .ToList();

        Assert.NotEmpty(credits);
        Assert.All(credits, r => Assert.Equal(ResourceShape.CreditRegistration, r!.Returns));
    }

    // stops a consumer promising scheduled syncs it cannot deliver: a provider needing a fresh code per sync cannot be scheduled
    [Theory]
    [InlineData(MockRegistryAdapters.Simple, true)]
    [InlineData(MockRegistryAdapters.TwoFactor, false)]
    public void Unattended_sync_is_offered_only_where_no_human_is_needed(string providerId, bool unattended)
    {
        var manifest = Registry.RequireManifest(providerId);

        Assert.Equal(unattended, manifest.UnattendedFetch);

        // the store is offered where it earns its keep: a password is worth keeping, six digits changing every 30s are not
        Assert.Equal(!unattended, manifest.OffersCredentialStore);
    }

    [Fact]
    public void A_two_factor_registry_declares_the_code_it_will_ask_for()
    {
        var manifest = Registry.RequireManifest(MockRegistryAdapters.TwoFactor);

        Assert.Equal(AuthFlow.PasswordTotp, manifest.Auth.Flow);
        Assert.Equal([ChallengeType.MfaCode], manifest.Auth.Challenges);

        // nothing to refresh: the next sync signs in again from the stored password and a new code
        Assert.False(manifest.Auth.Session.Refreshable);
        Assert.False(manifest.Auth.Session.RotatesOnUse);
    }

    [Fact]
    public async Task A_fetch_states_each_credit_the_way_the_register_does()
    {
        var adapter = new MockRegistryAdapter(MockRegistryAdapters.Simple, "Mock registry", twoFactor: false);

        using var ctx = new FakeJobContext();
        var result = await adapter.FetchAsync(ctx, Requests.Credits(), CancellationToken.None);

        Assert.Equal(3, result.Registrations.Count);

        var revolving = Assert.Single(result.Registrations, c => c.ExternalId == "MOCK-0001");
        Assert.Equal("Mock Bank N.V.", revolving.Creditor);
        Assert.Equal(CreditKind.Revolving, revolving.Kind);
        Assert.Equal(CreditStatus.Running, revolving.Status);
        Assert.Equal(200_000, revolving.Amount.Value);
        Assert.Equal("EUR", revolving.Amount.Currency);

        // revolving credit states no end date: null, not one computed from a term it lacks
        Assert.Null(revolving.EndsOn);

        // the registry's own words ride along so a label this connector does not recognise still reaches the user
        Assert.Equal("Doorlopend krediet", revolving.KindLabel);
    }

    // carried verbatim: softening an arrears code would hide what decides a mortgage application
    [Fact]
    public async Task An_arrears_code_is_carried_exactly_as_stated()
    {
        var adapter = new MockRegistryAdapter(MockRegistryAdapters.Simple, "Mock registry", twoFactor: false);

        using var ctx = new FakeJobContext();
        var result = await adapter.FetchAsync(ctx, Requests.Credits(), CancellationToken.None);

        var ended = Assert.Single(result.Registrations, c => c.ExternalId == "MOCK-0003");

        Assert.Equal("A2", ended.ArrearsCode);
        Assert.Equal(CreditStatus.Ended, ended.Status);

        // no arrears code stays null, not "none" or "A0": claims the register never made
        Assert.All(
            result.Registrations.Where(c => c.ExternalId != "MOCK-0003"),
            c => Assert.Null(c.ArrearsCode));
    }

    [Fact]
    public async Task A_two_factor_fetch_asks_for_six_digits_and_will_not_proceed_without_them()
    {
        var adapter = new MockRegistryAdapter(MockRegistryAdapters.TwoFactor, "Mock registry", twoFactor: true);

        using var ctx = new FakeJobContext { Answer = _ => MockRegistryAdapters.AcceptedCode };

        var result = await adapter.FetchAsync(ctx, Requests.Credits(), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, challenge.Type);
        Assert.Equal(6, challenge.Length);

        Assert.Equal(3, result.Registrations.Count);
    }

    // a wrong code is not a wrong password: reporting it so sends the user to reset a credential that was fine
    [Fact]
    public async Task A_wrong_code_is_an_mfa_failure_and_never_a_credential_one()
    {
        var adapter = new MockRegistryAdapter(MockRegistryAdapters.TwoFactor, "Mock registry", twoFactor: true);

        using var ctx = new FakeJobContext { Answer = _ => "000000" };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(ctx, Requests.Credits(), CancellationToken.None));

        Assert.Equal(ErrorCode.MfaFailed, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task A_registry_with_no_second_factor_asks_nothing_at_all()
    {
        var adapter = new MockRegistryAdapter(MockRegistryAdapters.Simple, "Mock registry", twoFactor: false);

        using var ctx = new FakeJobContext();
        await adapter.FetchAsync(ctx, Requests.Credits(), CancellationToken.None);

        Assert.Empty(ctx.Asked);
    }
}
