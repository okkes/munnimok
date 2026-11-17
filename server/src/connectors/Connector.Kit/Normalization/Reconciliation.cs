using Connector.Kit.Errors;

namespace Connector.Kit.Normalization;

// a provider's redundant fact (running balance, stated total vs lines, header count) is checked: unchecked it hides errors
public static class Reconciliation
{
    /// <summary>One cent, to absorb the provider's own rounding.</summary>
    public const long ToleranceMinorUnits = 1;

    // a failing receipt is emitted with Reconciled false, not dropped: dropping hides a real purchase,
    // trusting it hands over a total we know is inconsistent
    public static bool ItemsReconcile(Receipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);

        // a self-summed total agrees by construction: report "not reconciled", so the flag never means "nothing was checked"
        if (receipt.TotalIsDerived) return false;

        if (receipt.Items.Count == 0) return true;

        var sum = 0L;
        foreach (var item in receipt.Items)
        {
            sum += item.Total.Value;
            if (item.Discount is { } discount) sum += discount.Amount.Value;
        }

        return Math.Abs(sum - receipt.Total.Value) <= ToleranceMinorUnits;
    }

    public static Receipt WithReconciliation(this Receipt receipt) =>
        receipt with { Reconciled = ItemsReconcile(receipt) };

    // signed gap between the merchant's stated total and the itemised sum; zero when they agree
    public static long Unattributed(Receipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.Items.Count == 0) return 0;

        var itemised = 0L;
        foreach (var item in receipt.Items)
        {
            itemised += item.Total.Value;
            if (item.Discount is { } discount) itemised += discount.Amount.Value;
        }

        return receipt.Total.Value - itemised;
    }

    // closes the gap with one DERIVED line, not named a fee (amount known, reason not); the total stays the merchant's
    // own figure, because a bank transaction is matched against it
    public static Receipt WithUnattributedLine(this Receipt receipt, string labelKey)
    {
        ArgumentNullException.ThrowIfNull(receipt);

        var gap = Unattributed(receipt);
        if (Math.Abs(gap) <= ToleranceMinorUnits) return receipt.WithReconciliation();

        var line = new ReceiptItem
        {
            Name = labelKey,
            Kind = ReceiptLineKind.Unattributed,
            Total = new Money(gap, receipt.Total.Currency),
        };

        return (receipt with { Items = [.. receipt.Items, line] }).WithReconciliation();
    }
}

// verifies a provider's running balances: earlier balance + later amount = later balance; a break means misordered rows,
// a misread decimal, an inverted debit/credit flag or a dropped row
public static class BalanceChain
{
    // oldest-first; returns the first index that breaks the chain; rows with no stated balance are skipped
    public static int? FindBreak(IReadOnlyList<Transaction> ordered)
    {
        ArgumentNullException.ThrowIfNull(ordered);

        for (var i = 1; i < ordered.Count; i++)
        {
            var previous = ordered[i - 1].ResultingBalance;
            var current = ordered[i].ResultingBalance;
            if (previous is null || current is null) continue;

            var expected = previous.Value.Value + ordered[i].Amount.Value;
            if (Math.Abs(expected - current.Value.Value) > Reconciliation.ToleranceMinorUnits)
            {
                return i;
            }
        }

        return null;
    }

    // fails the run as ProviderChanged, not Internal: the export's shape moved and an adapter needs fixing
    public static void Verify(IReadOnlyList<Transaction> ordered, string providerId)
    {
        if (FindBreak(ordered) is not { } index) return;

        throw ConnectorException.ProviderChanged(
            $"{providerId}: balance chain broken at index {index} " +
            $"(external_id '{ordered[index].ExternalId}'); the export's shape or ordering changed");
    }
}
