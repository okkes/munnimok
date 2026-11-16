using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Connector.Kit.Normalization;

// must not change when a provider reorders its JSON or adds an ignored field, and must change on any meaningful value:
// that makes re-fetch overlap free, so adapters can widen their window for late-settling rows
public static class ContentHash
{
    // ASCII unit separator as a numeric escape, so the source carries no invisible control characters
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

        // items participate so a later detail fetch that fills them in produces a different hash
        foreach (var item in receipt.Items)
        {
            parts.Add(item.Name);
            parts.Add(item.Total.Value.ToString(CultureInfo.InvariantCulture));
            parts.Add((item.Quantity ?? 0m).ToString(CultureInfo.InvariantCulture));
        }

        return Compute([.. parts]);
    }

    // status participates, unlike a receipt's reconciliation verdict: running -> ended is the registry saying something new
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

    // components participate, not just the total: positions can sum equal yet differ (an unstopped ov-schuld). Nothing dated
    // participates, so a sync finding the same figures hashes the same, as wanted for a standing position
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

            // the as-of date participates: a balance recalculated to a new date is new from the provider even at an identical figure
            debt.AsOf?.ToString("O", CultureInfo.InvariantCulture) ?? string.Empty,
            debt.RepaymentMonthsRemaining?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
        };

        // stated history participates: a year closing or a restated start-of-repayment changes the record though the balance did not
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

    // length-prefixed so ("ab","c") and ("a","bc") cannot collide
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
