using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Api.Tests;

/// <summary>
/// The last leg: a record that reaches the wire still has to be written down.
///
/// <see cref="RecordsReachTheWireTests"/> in the kit pins the leg before this
/// one. This pins the leg after it, because they fail identically and silently:
/// the fetch succeeds, answers "complete", stages nothing, and the caller is
/// shown an empty list. On a page whose job is to say what somebody owes, an
/// empty list does not read as a defect - it reads as "you owe nothing".
/// </summary>
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

        // And the payload is the record, not a placeholder: the figure a
        // consumer renders has to survive serialisation.
        Assert.Contains("\"total\"", staged.PayloadJson, StringComparison.Ordinal);
        Assert.Contains("1243477", staged.PayloadJson, StringComparison.Ordinal);
    }

    /// <summary>
    /// Ids and hashes are minted by the platform, never by the adapter - an
    /// adapter that invented its own would break the idempotency the whole
    /// pipeline rests on.
    /// </summary>
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
        // One record of every shape at once, and the count has to match. A
        // list added to the wire without a loop in Enumerate is exactly the
        // gap that shipped, one leg further along.
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
