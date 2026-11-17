using System.Globalization;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Mock;

/// Fixture amounts are minor units (*_minor), declared as MoneyUnit.Minor like the real adapters do.
/// The file's receipts are the first cycle on fixed days (ids and hashes stay stable); each repeats every
/// ReceiptCycleDays at the same wall-clock time up to now, so the store stays inside the platform's window on any day.
internal static class MockReceiptFixture
{
    public static IReadOnlyList<Receipt> Read(
        string fixtureName, string providerId, string sessionId, bool withItems, DateTimeOffset now, int historyDays)
    {
        using var document = JsonDocument.Parse(FixtureCatalog.Read(fixtureName));
        var root = document.RootElement;

        var currency = JsonAccess.StrOf(root, "currency") ?? "EUR";
        var merchantName = JsonAccess.StrOf(root, "merchant") ?? "Mock Store";

        var rows = JsonAccess.Array(root, "receipts");
        if (rows.Count == 0)
        {
            throw ConnectorException.ProviderChanged($"{providerId}: fixture '{fixtureName}' holds no receipts");
        }

        var oldest = DateOnly.FromDateTime(now.UtcDateTime).AddDays(-historyDays);
        var receipts = new List<Receipt>(rows.Count);
        foreach (var row in rows)
        {
            var externalId = JsonAccess.StrOf(row, "external_id")
                             ?? throw ConnectorException.ProviderChanged(
                                 $"{providerId}: fixture row without an external_id");

            var payment = JsonAccess.TryProp(row, out var paymentNode, "payment")
                ? ReceiptFactory.Payment(
                    JsonAccess.StrOf(paymentNode, "method"),
                    JsonAccess.StrOf(paymentNode, "card_last4"),
                    JsonAccess.StrOf(paymentNode, "iban_tail"))
                : ReceiptFactory.Payment();

            var merchant = new Merchant
            {
                Id = providerId,
                Name = merchantName,
                StoreName = JsonAccess.StrOf(row, "store_name"),
            };

            // fixtures carry a real offset, so the mocks prove the rule the real adapters enforce by hand
            var first = ReceiptTime.Parse(JsonAccess.StrOf(row, "purchased_at"), RetailZones.Dutch, providerId, "purchased_at");
            var total = MoneyReader.Require(row, MoneyUnit.Minor, currency, "receipt.total", "total_minor");
            IReadOnlyList<ReceiptItem> items = withItems ? Items(row, currency) : [];
            var sequence = Sequence(externalId, first, providerId);

            foreach (var purchasedAt in Repeats(first, now))
            {
                var day = DateOnly.FromDateTime(purchasedAt.DateTime);
                if (day < oldest) continue;

                receipts.Add(ReceiptFactory.Build(sessionId, IdOn(day, sequence), merchant, purchasedAt, total, payment, items));
            }
        }

        return [.. receipts.OrderByDescending(r => r.PurchasedAt)];
    }

    /// repeats keep the same wall-clock time in the store's zone; the offset follows the season
    private static IEnumerable<DateTimeOffset> Repeats(DateTimeOffset first, DateTimeOffset now)
    {
        var wallClock = first.DateTime;
        var at = first;
        while (at <= now)
        {
            yield return at;
            wallClock = wallClock.AddDays(MockStoreAdapters.ReceiptCycleDays);
            at = new DateTimeOffset(wallClock, RetailZones.Dutch.GetUtcOffset(wallClock));
        }
    }

    /// what follows the day in an id; a repeat carries its own day, so the first cycle keeps the file's ids exactly
    private static string Sequence(string externalId, DateTimeOffset first, string providerId)
    {
        var prefix = IdOn(DateOnly.FromDateTime(first.DateTime), string.Empty);
        return externalId.Length > prefix.Length && externalId.StartsWith(prefix, StringComparison.Ordinal)
            ? externalId[prefix.Length..]
            : throw ConnectorException.ProviderChanged(
                $"{providerId}: fixture id '{externalId}' does not start with its own day ('{prefix}')");
    }

    private static string IdOn(DateOnly day, string sequence) =>
        string.Create(CultureInfo.InvariantCulture, $"mock-{day:yyyy-MM-dd}-{sequence}");

    private static List<ReceiptItem> Items(JsonElement row, string currency)
    {
        var lines = JsonAccess.Array(row, "items");
        var items = new List<ReceiptItem>(lines.Count);

        foreach (var line in lines)
        {
            // a nameless line is a broken fixture: fail the suite rather than emit fewer items than the file lists
            var name = JsonAccess.StrOf(line, "name")
                       ?? throw ConnectorException.ProviderChanged("mock: fixture item without a name");

            items.Add(new ReceiptItem
            {
                Name = name,
                Quantity = JsonAccess.Quantity(line, "quantity"),
                UnitPrice = MoneyReader.Optional(line, MoneyUnit.Minor, currency, "item.unit_price", "unit_price_minor"),
                Total = MoneyReader.Require(line, MoneyUnit.Minor, currency, "item.total", "total_minor"),
                Discount = JsonAccess.TryProp(line, out var discount, "discount")
                    ? new ReceiptDiscount
                    {
                        Amount = MoneyReader.Require(discount, MoneyUnit.Minor, currency,
                            "item.discount", "amount_minor"),
                        Label = JsonAccess.StrOf(discount, "label"),
                    }
                    : null,
            });
        }

        return items;
    }
}
