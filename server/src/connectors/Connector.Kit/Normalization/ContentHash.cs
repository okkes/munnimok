using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Connector.Kit.Normalization;

/// <summary>
/// A stable hash of the facts that make a record what it is.
///
/// Two properties matter and both are load-bearing: it must not change when
/// a provider reorders its JSON or adds a field we ignore, and it must
/// change when any meaningful value does. That is what makes re-fetch
/// overlap free, which in turn is what lets every adapter widen its window
/// to catch late-settling rows.
/// </summary>
public static class ContentHash
{
    /// <summary>
    /// ASCII unit separator. Written as a numeric escape rather than a
    /// literal so the source carries no invisible control characters.
    /// </summary>
    private const char Separator = (char)0x1F;

    public static string Of(Transaction tx)
    {
        ArgumentNullException.ThrowIfNull(tx);
        return Compute(
            tx.ExternalId,
            tx.AccountId,
            tx.BookedAt.ToString("O", CultureInfo.InvariantCulture),
            tx.Amount.Value.ToString(CultureInfo.InvariantCulture),
            tx.Amount.Currency,
            tx.Description ?? string.Empty,
            tx.Counterparty?.Name ?? string.Empty,
            tx.Counterparty?.Iban ?? string.Empty);
    }

    public static string Of(Receipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        var parts = new List<string>
        {
            receipt.ExternalId,
            receipt.Merchant.Id,
            receipt.PurchasedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            receipt.Total.Value.ToString(CultureInfo.InvariantCulture),
            receipt.Total.Currency,
            receipt.Items.Count.ToString(CultureInfo.InvariantCulture),
        };

        // Items participate so a detail fetch that later fills them in
        // produces a different hash - the summary and the detailed record
        // are genuinely different content.
        foreach (var item in receipt.Items)
        {
            parts.Add(item.Name);
            parts.Add(item.Total.Value.ToString(CultureInfo.InvariantCulture));
            parts.Add((item.Quantity ?? 0m).ToString(CultureInfo.InvariantCulture));
        }

        return Compute([.. parts]);
    }

    /// <summary>
    /// The facts a registry states about one credit.
    ///
    /// Status participates, unlike a receipt's reconciliation verdict: a
    /// credit moving from running to ended is the registry saying something
    /// new about it, not us reaching a different opinion about the same
    /// content. A consumer must see that as a changed record.
    /// </summary>
    public static string Of(CreditRegistration credit)
    {
        ArgumentNullException.ThrowIfNull(credit);
        return Compute(
            credit.ExternalId,
            credit.Creditor,
            credit.Kind.ToString(),
            credit.Amount.Value.ToString(CultureInfo.InvariantCulture),
            credit.Amount.Currency,
            credit.Status.ToString(),
            credit.StartedOn?.ToString("O", CultureInfo.InvariantCulture) ?? string.Empty,
            credit.EndsOn?.ToString("O", CultureInfo.InvariantCulture) ?? string.Empty,
            credit.MonthlyAmount?.Value.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            credit.ArrearsCode ?? string.Empty);
    }

    /// <summary>
    /// What a student-finance body states is owed.
    ///
    /// The components participate, not just the total. Two positions can add
    /// up to the same figure while meaning different things - an ov-schuld
    /// appearing as a loan shrinks by the same amount is somebody's travel
    /// product having gone unstopped, and a hash keyed on the total alone
    /// would report that as no change at all.
    /// </summary>
    /// <remarks>
    /// Nothing dated participates, because nothing dated exists - see the note
    /// on <see cref="StudentDebt"/>. A sync that finds the same figures
    /// therefore hashes the same and costs the consumer nothing, which is the
    /// behaviour wanted: this is a standing position that is expected to sit
    /// unchanged for a month at a time.
    /// </remarks>
    public static string Of(StudentDebt debt)
    {
        ArgumentNullException.ThrowIfNull(debt);

        var parts = new List<string>
        {
            debt.ExternalId,
            debt.Total.Value.ToString(CultureInfo.InvariantCulture),
            debt.Total.Currency,
            debt.TotalIsDerived ? "derived" : "stated",
            debt.Phase.ToString(),
            debt.InterestRate?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            debt.InterestRegime ?? string.Empty,
            debt.PaymentHolidayMonthsRemaining?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,

            // The as-of date participates, and that is a deliberate change of
            // behaviour: a balance recalculated to a new date is the provider
            // saying something new about it, even when the figure is identical.
            // A consumer showing "as of 1 July" when the provider now says
            // 1 August is stale in exactly the way this field exists to reveal.
            debt.AsOf?.ToString("O", CultureInfo.InvariantCulture) ?? string.Empty,
            debt.RepaymentMonthsRemaining?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
        };

        // Stated history participates too. A year closing, or the provider
        // restating what was owed at the start of repayment, changes the record
        // a consumer holds even though today's balance did not move.
        foreach (var stated in debt.History)
        {
            parts.Add(stated.Kind.ToString());
            parts.Add(stated.Year?.ToString(CultureInfo.InvariantCulture) ?? string.Empty);
            parts.Add(stated.On?.ToString("O", CultureInfo.InvariantCulture) ?? string.Empty);
            parts.Add(stated.Amount.Value.ToString(CultureInfo.InvariantCulture));
            parts.Add(stated.Label ?? string.Empty);
        }

        foreach (var component in debt.Components)
        {
            parts.Add(component.Kind.ToString());
            parts.Add(component.SourceField);
            parts.Add(component.Amount.Value.ToString(CultureInfo.InvariantCulture));
        }

        return Compute([.. parts]);
    }

    public static string Of(Account account)
    {
        ArgumentNullException.ThrowIfNull(account);
        return Compute(
            account.ExternalId,
            account.Type.ToString(),
            account.DisplayName,
            account.Iban ?? string.Empty,
            account.Currency,
            account.Balance?.Amount.Value.ToString(CultureInfo.InvariantCulture) ?? string.Empty);
    }

    /// <summary>
    /// Length-prefixed so that no rearrangement of field boundaries can
    /// collide - ("ab","c") and ("a","bc") must not hash the same.
    /// </summary>
    private static string Compute(params string[] parts)
    {
        var sb = new StringBuilder();
        foreach (var part in parts)
        {
            sb.Append(part.Length.ToString(CultureInfo.InvariantCulture))
                .Append(':')
                .Append(part)
                .Append(Separator);
        }

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return "sha256:" + Convert.ToHexStringLower(digest);
    }
}
