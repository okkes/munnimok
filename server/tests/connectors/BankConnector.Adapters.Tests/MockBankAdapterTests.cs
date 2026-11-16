using BankConnector.Adapters.MockBank;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

// driven through the real fetch path so the balance-chain check is reached as a live adapter reaches it; no
// socket, no browser, nothing that moves with the calendar
public sealed class MockBankAdapterTests
{
    /// <summary>Pinned so a window is a fixed range; the ledger runs through whatever day the clock says.</summary>
    private static readonly DateTimeOffset Now = new(2026, 7, 26, 12, 0, 0, TimeSpan.Zero);

    private static readonly DateOnly Today = DateOnly.FromDateTime(Now.UtcDateTime);

    private static readonly IReadOnlyDictionary<string, string> GoodCredentials =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = MockBankCredentials.Username,
            ["password"] = MockBankCredentials.Password,
        };

    /// <summary>The slow provider paces itself by config; zero keeps the suite from sleeping.</summary>
    private static readonly IReadOnlyDictionary<string, string> Instant =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [MockBankSlowAdapter.RunSecondsKey] = "0",
        };

    private static IReadOnlyList<IProviderAdapter> Fleet() => BankAdapters.MockFleet(new FixedTimeProvider(Now));

    public static TheoryData<string> FleetIds
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var adapter in BankAdapters.MockFleet()) data.Add(adapter.Describe().Id);
            return data;
        }
    }

    private static IProviderAdapter Adapter(string providerId) =>
        Fleet().Single(a => string.Equals(a.Describe().Id, providerId, StringComparison.Ordinal));

    private static ResourceRequest Transactions(DateOnly? since = null) => new()
    {
        ResourceId = BankResources.Transactions,
        Since = since,
    };

    private static string AnswerFor(Challenge challenge) => challenge.Type switch
    {
        ChallengeType.CodeDisplay => "550193",

        // Passive: the human approves in an app and there is nothing to type.
        ChallengeType.AppApproval => string.Empty,
        ChallengeType.MfaCode => "123456",
        _ => throw new InvalidOperationException($"unexpected challenge {challenge.Type}"),
    };

    [Fact]
    public void The_registry_validates_every_manifest_in_the_fleet()
    {
        var registry = BankAdapters.MockRegistry();

        Assert.Equal(6, registry.Manifests.Count);
        Assert.All(registry.Manifests, ManifestValidator.Validate);

        // only providers whose manifest says agent.required: false may run in a browserless control plane, or a job is
        // leased that no local process can serve; the consent mock is the aggregator shape (#414)
        Assert.Equal(
            ["mock-bank-broken", "mock-bank-consent", "mock-bank-simple"],
            BankAdapters.InlineOnly().Select(a => a.Describe().Id).Order(StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(FleetIds))]
    public async Task No_provider_in_the_fleet_opens_a_socket_or_starts_a_browser(string providerId)
    {
        var handler = new ThrowingHttpHandler();
        using var ctx = new FakeJobContext(handler)
        {
            Inputs = new Dictionary<string, string>(GoodCredentials, StringComparer.Ordinal)
            {
                [MockBankPersistentAdapter.AgentIdKey] = Ids.New(Ids.Agent),
            },
            Config = Instant,
            Answer = AnswerFor,
            Material = new Connector.Kit.Security.SessionMaterial
            {
                StorageState = MockBankCredentials.StorageState,
                AgentId = Ids.New(Ids.Agent),
                ProfileId = Ids.New(Ids.Profile),
            },
        };

        var adapter = Adapter(providerId);

        await Swallow(() => adapter.LoginAsync(ctx, CancellationToken.None));
        await Swallow(() => adapter.FetchAsync(ctx, Transactions(), CancellationToken.None));

        Assert.Equal(0, handler.Calls);

        // the T3 and T4 mocks declare a browser tier for routing and agent-class logic, never to start Chromium
        Assert.False(ctx.Browser.Started);
    }

    [Fact]
    public async Task The_simple_provider_serves_a_verified_statement()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var adapter = Adapter(MockBankSimpleAdapter.ProviderId);
        var login = await adapter.LoginAsync(ctx, CancellationToken.None);

        Assert.True(ctx.CredentialWasSubmitted);
        Assert.Equal(3, login.Reachable.Count);
        Assert.Equal(MockBankLedger.CurrentIban, login.Account?.ExternalId);
        Assert.Equal(Now.AddSeconds(2_592_000), login.ExpiresAt);

        var result = await adapter.FetchAsync(ctx, Transactions(), CancellationToken.None);

        Assert.NotEmpty(result.Transactions);
        Assert.Equal(3, result.Accounts.Count);
        Assert.Equal("fixture", result.Via);
        Assert.True(result.Complete);

        // BankEmission.Verified is the only way a mock returns a FetchResult, so the chain check cannot be skipped
        BankEmission.VerifyPerAccount(MockBankSimpleAdapter.ProviderId, result.Transactions);
    }

    [Fact]
    public async Task The_default_window_is_widened_by_the_settlement_lag()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var result = await Adapter(MockBankSimpleAdapter.ProviderId)
            .FetchAsync(ctx, Transactions(), CancellationToken.None);

        // a card payment on the 19th can surface on the 21st still dated the 19th: fetching strictly since the last sync
        // loses it, so the window is widened and the content hash absorbs the overlap
        var earliest = result.Transactions.Min(t => t.BookedAt);
        var floor = Today.AddDays(-(BankWindow.DefaultSinceDays + BankLimits.DutchCardSettlementLagDays));

        Assert.True(earliest >= floor, $"{earliest} predates the widened window");
        Assert.True(earliest < Today.AddDays(-BankWindow.DefaultSinceDays));
    }

    // the ledger ends on the provider's own today, so its history limit is filled on any clock; a fixed last day came
    // back empty from 2027-01-23 on
    [Fact]
    public async Task The_history_follows_the_clock_and_always_reaches_back_its_limit()
    {
        var later = new DateTimeOffset(2031, 3, 14, 12, 0, 0, TimeSpan.Zero);
        var today = DateOnly.FromDateTime(later.UtcDateTime);
        var floor = today.AddDays(-MockBankLedger.HistoryDays);
        var adapter = BankAdapters.MockFleet(new FixedTimeProvider(later))
            .Single(a => string.Equals(a.Describe().Id, MockBankSimpleAdapter.ProviderId, StringComparison.Ordinal));
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var result = await adapter.FetchAsync(ctx, Transactions(since: today.AddYears(-2)), CancellationToken.None);

        Assert.True(result.Complete);
        Assert.InRange(result.Transactions.Min(t => t.BookedAt), floor, floor.AddDays(7));
        Assert.InRange(result.Transactions.Max(t => t.BookedAt), today.AddDays(-7), today);
        BankEmission.VerifyPerAccount(MockBankSimpleAdapter.ProviderId, result.Transactions);
    }

    [Fact]
    public async Task A_caller_may_filter_by_account_type_and_is_told_when_it_asks_for_one_that_is_not_reachable()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };
        var adapter = Adapter(MockBankSimpleAdapter.ProviderId);

        var savings = await adapter.FetchAsync(
            ctx,
            new ResourceRequest
            {
                ResourceId = BankResources.Transactions,
                Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                {
                    ["accounts"] = ["savings"],
                },
            },
            CancellationToken.None);

        var account = Assert.Single(savings.Accounts);
        Assert.Equal(AccountType.Savings, account.Type);
        Assert.All(savings.Transactions, t => Assert.Equal(account.Id, t.AccountId));

        var error = await Assert.ThrowsAsync<ConnectorException>(() => adapter.FetchAsync(
            ctx,
            new ResourceRequest
            {
                ResourceId = BankResources.Transactions,
                Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                {
                    ["accounts"] = ["loan"],
                },
            },
            CancellationToken.None));

        // never a silent empty result: it reads as "no loan transactions" rather than "you asked wrong"
        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
        Assert.Contains("reachable:", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_broken_provider_fails_a_fetch_through_the_real_verifier()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankBrokenAdapter.ProviderId).FetchAsync(ctx, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);

        // the failure comes from BalanceChain.Verify on deliberately inconsistent data, not from a hand-thrown message
        Assert.Contains("balance chain broken", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_broken_provider_fails_a_login_before_any_credential_is_submitted()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankBrokenAdapter.ProviderId).LoginAsync(ctx, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);

        // the login fails before any password is sent, the honest order for a vanished login selector: the job may be
        // requeued safely
        Assert.False(ctx.CredentialWasSubmitted);
    }

    // the broken one fails before the form and the persistent one authenticated on the user's hardware: neither has a
    // credential to latch
    public static TheoryData<string> CredentialSubmitters =>
        new(MockBankSimpleAdapter.ProviderId, MockBankScaAdapter.ProviderId, MockBankSlowAdapter.ProviderId);

    [Theory]
    [MemberData(nameof(CredentialSubmitters))]
    public async Task A_rejected_password_latches_the_credential_and_is_never_retried(string providerId)
    {
        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = MockBankCredentials.Username,
                ["password"] = MockBankCredentials.RejectedPassword,
            },
            Config = Instant,
            Answer = AnswerFor,
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(providerId).LoginAsync(ctx, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);
        Assert.False(error.Retriable);
        Assert.Contains(ErrorCode.InvalidCredentials, ErrorCatalog.NeverRetry);

        // latched before the verdict: once a credential has gone upstream a lost lease must fail the job permanently.
        // three retries locks a real bank account
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task The_sca_provider_relays_a_displayed_code_then_waits_for_an_app_approval()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials, Answer = AnswerFor };

        await Adapter(MockBankScaAdapter.ProviderId).LoginAsync(ctx, CancellationToken.None);

        Assert.Equal(2, ctx.Asked.Count);

        // the one case where the code travels outward: shown, keyed into a device, the device's answer read back
        Assert.Equal(ChallengeType.CodeDisplay, ctx.Asked[0].Type);
        Assert.Equal(MockBankCredentials.DisplayedCode, ctx.Asked[0].Code);

        Assert.Equal(ChallengeType.AppApproval, ctx.Asked[1].Type);
        Assert.True(ctx.Asked[1].IsPassive);

        // mandatory and short: a stale challenge must release its agent instead of pinning it for the whole job timeout
        Assert.All(ctx.Asked, challenge => Assert.True(challenge.ExpiresAt > Now));
    }

    [Fact]
    public async Task A_wrong_device_response_is_mfa_failed()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials, Answer = _ => "nope" };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankScaAdapter.ProviderId).LoginAsync(ctx, CancellationToken.None));

        Assert.Equal(ErrorCode.MfaFailed, error.Code);
        Assert.Contains(ErrorCode.MfaFailed, ErrorCatalog.NeverRetry);
    }

    [Fact]
    public async Task A_stored_browser_session_skips_the_sca_challenge_on_a_fetch()
    {
        using var ctx = new FakeJobContext
        {
            Material = new Connector.Kit.Security.SessionMaterial
            {
                StorageState = MockBankCredentials.StorageState,
            },
        };

        var result = await Adapter(MockBankScaAdapter.ProviderId)
            .FetchAsync(ctx, Transactions(), CancellationToken.None);

        // a stored storage state turns T3 into T2 for most of a session; asking again would waste a human
        Assert.Empty(ctx.Asked);
        Assert.NotEmpty(result.Transactions);
    }

    [Fact]
    public async Task The_persistent_provider_returns_a_pointer_and_no_secret_at_all()
    {
        var agentId = Ids.New(Ids.Agent);
        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [MockBankPersistentAdapter.AgentIdKey] = agentId,
            },
        };

        var result = await Adapter(MockBankPersistentAdapter.ProviderId).LoginAsync(ctx, CancellationToken.None);

        // agent custody: a breach of the connector yields nothing, it never held anything
        Assert.True(result.Material.IsAgentPointer);
        Assert.Equal(agentId, result.Material.AgentId);
        Assert.StartsWith("prf_", result.Material.ProfileId, StringComparison.Ordinal);
        Assert.Null(result.Material.AccessToken);
        Assert.Null(result.Material.StorageState);

        // the human authenticated into the profile on their own machine long before this job
        Assert.False(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task A_persistent_session_that_names_no_agent_says_so_rather_than_retrying()
    {
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankPersistentAdapter.ProviderId)
                .FetchAsync(ctx, Transactions(), CancellationToken.None));

        // an agent that is off gets "start your agent", not a retry loop against a missing host
        Assert.Equal(ErrorCode.AgentUnavailable, error.Code);
        Assert.Equal(UserAction.StartYourAgent, ErrorCatalog.ActionFor(error.Code));
    }

    [Fact]
    public async Task The_accounts_resource_is_served_without_a_transaction_in_sight()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var result = await Adapter(MockBankSimpleAdapter.ProviderId).FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, CancellationToken.None);

        Assert.Equal(3, result.Accounts.Count);
        Assert.Empty(result.Transactions);
    }

    [Fact]
    public async Task An_unknown_resource_is_refused()
    {
        using var ctx = new FakeJobContext { Inputs = GoodCredentials };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankSimpleAdapter.ProviderId).FetchAsync(
                ctx, new ResourceRequest { ResourceId = "receipts" }, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_missing_login_input_is_refused_before_anything_is_submitted(string omitted)
    {
        var inputs = new Dictionary<string, string>(GoodCredentials, StringComparer.Ordinal);
        inputs.Remove(omitted);

        using var ctx = new FakeJobContext { Inputs = inputs };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankSimpleAdapter.ProviderId).LoginAsync(ctx, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.False(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task An_out_of_range_run_length_is_refused()
    {
        using var ctx = new FakeJobContext
        {
            Inputs = GoodCredentials,
            Config = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [MockBankSlowAdapter.RunSecondsKey] = "9999",
            },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(MockBankSlowAdapter.ProviderId).LoginAsync(ctx, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
    }

    /// <summary>A provider's legitimate failure must not decide a whole-fleet assertion, which is about the invariant.</summary>
    private static async Task Swallow(Func<Task> call)
    {
        try
        {
            await call();
        }
        catch (ConnectorException)
        {
            // mock-bank-broken raises provider_changed by design, also without contacting anything
        }
    }
}
