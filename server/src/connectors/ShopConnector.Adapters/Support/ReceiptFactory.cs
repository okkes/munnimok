using Connector.Kit;
using Connector.Kit.Jobs;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Support;

/// a derived total is our sum of the lines, which can never be reconciled against itself
internal readonly record struct ReceiptTotal(Money Amount, bool IsDerived = false);

/// the single construction point: no adapter can forget the reconciliation verdict and the content hash
internal static class ReceiptFactory
{
    public static Receipt Build(
        string sessionId,
        string externalId,
        Merchant merchant,
        DateTimeOffset purchasedAt,
        Money total,
        ReceiptPayment payment,
        IReadOnlyList<ReceiptItem> items) =>
        Build(sessionId, externalId, merchant, purchasedAt, new ReceiptTotal(total), payment, items);

    public static Receipt Build(
        string sessionId,
        string externalId,
        Merchant merchant,
        DateTimeOffset purchasedAt,
        ReceiptTotal total,
        ReceiptPayment payment,
        IReadOnlyList<ReceiptItem> items)
    {
        // derivation travels WITH the total: the verdict is computed from it, and `with { TotalIsDerived = true }`
        // on a finished receipt would leave Reconciled lying
        var receipt = new Receipt
        {
            Id = Ids.ForRecord(Ids.Receipt, sessionId, externalId),
            ExternalId = externalId,
            Merchant = merchant,
            PurchasedAt = purchasedAt,
            Total = total.Amount,
            Payment = payment,
            Items = items,
            TotalIsDerived = total.IsDerived,
        }.WithReconciliation();

        return receipt with { ContentHash = ContentHash.Of(receipt) };
    }

    /// every field stated, nulls included: the consumer matches on the payment tail,
    /// and an explicit null says the match is weaker
    public static ReceiptPayment Payment(string? method = null, string? cardLast4 = null, string? ibanTail = null) =>
        new() { Method = method, CardLast4 = cardLast4, IbanTail = ibanTail };

    /// the platform already widened a caller's since by the provider's settlement lag,
    /// so this compares against the request as given
    public static bool InWindow(DateTimeOffset purchasedAt, ResourceRequest request)
    {
        var day = DateOnly.FromDateTime(purchasedAt.Date);
        if (request.Since is { } since && day < since) return false;
        if (request.Until is { } until && day > until) return false;
        return true;
    }
}
