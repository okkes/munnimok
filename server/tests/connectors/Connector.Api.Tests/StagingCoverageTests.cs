using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Api.Tests;

// pins the leg after RecordsReachTheWireTests: a fetch that stages nothing answers "complete" with an empty list,
// which on a page about what somebody owes reads as "you owe nothing"
public sealed class StagingCoverageTests
{
    private const string Session = "ses_staging_fixture";

    [Fact]
    public void A_student_debt_is_staged_with_its_own_id_prefix()
    {
        var result = new JobResultRequest { Debts = [Debt()] };

        var staged = Assert.Single(ResultService.Enumerate(result, Session));

        Assert.Equal("student-debt", staged.ExternalId);
        Assert.StartsWith("sdt_", staged.Id, StringComparison.Ordinal);
        Assert.StartsWith("sha256:", staged.ContentHash, StringComparison.Ordinal);

        Assert.Contains("\"total\"", staged.PayloadJson, StringComparison.Ordinal);
        Assert.Contains("1243477", staged.PayloadJson, StringComparison.Ordinal);
    }

    // ids and hashes are minted by the platform: an adapter's own would break the pipeline's idempotency
    [Fact]
    public void The_platform_overwrites_whatever_the_adapter_put_in_the_id()
    {
        var result = new JobResultRequest
        {
            Debts = [Debt() with { Id = "nonsense", ContentHash = "nonsense" }],
        };

        var staged = Assert.Single(ResultService.Enumerate(result, Session));

        Assert.NotEqual("nonsense", staged.Id);
        Assert.NotEqual("nonsense", staged.ContentHash);
    }

    [Fact]
    public void Every_list_on_the_wire_is_staged_by_something()
    {
        // a list added to the wire without a loop in Enumerate is the gap that shipped
        var result = new JobResultRequest
        {
            Accounts =
            [
                new Account
                {
                    Id = "x", ExternalId = "acc-1", Type = AccountType.Current,
                    DisplayName = "Fixture", Currency = "EUR",
                },
            ],
            Transactions =
            [
                new Transaction
                {
                    Id = "x", ExternalId = "txn-1", AccountId = "acc-1",
                    BookedAt = new DateOnly(2026, 8, 10), Amount = Money.Eur(-100),
                },
            ],
            Receipts =
            [
                new Receipt
                {
                    Id = "x", ExternalId = "rcp-1",
                    Merchant = new Merchant { Id = "m", Name = "Fixture" },
                    PurchasedAt = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero),
                    Total = Money.Eur(100),
                },
            ],
            Registrations =
            [
                new CreditRegistration
                {
                    Id = "x", ExternalId = "crd-1", Creditor = "Fixture",
                    Kind = CreditKind.Instalment, Amount = Money.Eur(100), Status = CreditStatus.Running,
                },
            ],
            Debts = [Debt()],
        };

        Assert.Equal(5, ResultService.Enumerate(result, Session).Count());
    }

    private static StudentDebt Debt() => new()
    {
        Id = "x",
        ExternalId = "student-debt",
        Total = Money.Eur(1_243_477),
        TotalIsDerived = true,
        Phase = StudentDebtPhase.Repaying,
        Components =
        [
            new StudentDebtComponent
            {
                Kind = StudentDebtKind.Loan,
                SourceField = "schuldbedragLening",
                Amount = Money.Eur(1_243_477),
            },
        ],
    };
}
