using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.AlbertHeijn;

internal sealed record AhReceiptSummary
{
    public required string Id { get; init; }

    public required DateTimeOffset PurchasedAt { get; init; }

    /// the only total AH states; the detail selects none, so list and detail are a real reconciliation pair
    public required Money Total { get; init; }

    /// this receipt's own list row when include=raw asked, else null; the row and never the page, which holds other receipts
    public string? Raw { get; init; }
}

/// field names confirmed from gwillem/appie-go v0.0.12 and read exactly (see TryField);
/// amounts are JSON numbers in euros, unit declared per field in the options
internal static class AlbertHeijnReceiptParser
{
    private const string ProviderId = AlbertHeijnAdapter.ProviderId;

    /// GraphQL reports a failure in the body with a 200; a status-only check would return an empty history,
    /// which reads as "never shopped here"
    public static void ThrowOnErrors(JsonElement root)
    {
        var errors = JsonAccess.Array(root, "errors");
        if (errors.Count == 0) return;

        // the first message only: the rest usually restate the same fault per selected field
        var first = errors[0];
        var message = JsonAccess.StrOf(first, "message")
                      ?? (JsonAccess.TryProp(first, out var extensions, "extensions")
                          ? JsonAccess.StrOf(extensions, "code")
                          : null)
                      ?? "unspecified";

        throw ConnectorException.ProviderChanged($"{ProviderId}: graphql returned an error ({message})");
    }

    public static IReadOnlyList<AhReceiptSummary> ParseList(
        JsonElement root, AlbertHeijnOptions options, bool keepRaw = false)
    {
        if (!TryField(root, "posReceiptsPage", out var page))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the response carries no posReceiptsPage; the receipts operation moved");
        }

        // a null page is an answer (nothing on the account), not a shape change
        if (page.ValueKind == JsonValueKind.Null) return [];

        if (page.ValueKind != JsonValueKind.Object)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: posReceiptsPage is a {page.ValueKind}, not an object");
        }

        var node = page.Child("posReceipts");

        // undefined, not null: only an ABSENT field means a query we have stopped sending
        if (node.ValueKind == JsonValueKind.Undefined)
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: posReceiptsPage carries no posReceipts");
        }

        if (node.ValueKind == JsonValueKind.Null) return [];

        if (node.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: posReceipts is a {node.ValueKind}, not a list");
        }

        var zone = RetailZones.Dutch;
        var rows = JsonAccess.AsArray(node);
        var summaries = new List<AhReceiptSummary>(rows.Count);

        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];

            // a row without an id is a shape change: skipping it shortened the page, which the caller reads as the end of history,
            // hiding everything older from a pass reporting itself complete
            if (JsonAccess.StrOf(row, "id") is not { } id || string.IsNullOrWhiteSpace(id))
            {
                throw ConnectorException.ProviderChanged(
                    $"{ProviderId}: posReceipts[{index}] carries no id, so it can be neither deduplicated "
                    + "nor fetched - and dropping it would shorten the page, which reads as the end of the "
                    + "history");
            }

            summaries.Add(new AhReceiptSummary
            {
                Id = id,
                // AH sends a local Dutch wall clock: read in Europe/Amsterdam, not the agent's zone
                // (a near-midnight purchase dated a day out is worse than one never matched)
                PurchasedAt = ReceiptTime.Parse(
                    JsonAccess.StrOf(row, "dateTime"), zone, ProviderId, "posReceipt.dateTime"),
                Total = MoneyReader.Require(row, options.ListTotalUnit, options.Currency,
                    "posReceipt.totalAmount", "totalAmount"),
                Raw = keepRaw ? row.GetRawText() : null,
            });
        }

        return summaries;
    }

    /// AH states discounts in their own array linked to no product, so each is its own negative line, not attached to a guess
    public static IReadOnlyList<ReceiptItem> ParseItems(JsonElement root, AlbertHeijnOptions options)
    {
        var detail = RequireDetail(root);
        var currency = options.Currency;

        var products = JsonAccess.Array(detail, "products");
        var discounts = JsonAccess.Array(detail, "discounts");
        var items = new List<ReceiptItem>(products.Count + discounts.Count);

        foreach (var product in products)
        {
            var name = JsonAccess.StrOf(product, "name");
            if (string.IsNullOrWhiteSpace(name)) continue;

            var total = MoneyReader.Optional(product, options.ItemAmountUnit, currency,
                $"product[{name}].amount", "amount");
            if (total is not { } amount) continue;

            items.Add(new ReceiptItem
            {
                Name = name,
                Quantity = JsonAccess.Quantity(product, "quantity"),
                // only AH's own unit price: total divided by quantity is wrong for anything sold by weight
                UnitPrice = MoneyReader.Optional(product, options.ItemAmountUnit, currency,
                    $"product[{name}].price", "price"),
                Total = amount,
            });
        }

        foreach (var discount in discounts)
        {
            // an absent confirmed field is a shape change that moves money: dropping the line would break the receipt's arithmetic
            var label = JsonAccess.StrOf(discount, "name")
                        ?? throw ConnectorException.ProviderChanged(
                            $"{ProviderId}: a discount line carries no name");

            var amount = MoneyReader.Require(discount, options.DiscountAmountUnit, currency,
                $"discount[{label}].amount", "amount");

            items.Add(new ReceiptItem
            {
                Name = label,
                // negative by contract whichever sign AH chose, so summing a receipt is unconditional
                Total = amount.Value > 0 ? amount.Negated() : amount,
            });
        }

        return items;
    }

    /// both tails are null by construction (the operation selects neither); explicit because the consumer's match is weaker here
    public static ReceiptPayment ParsePayment(JsonElement root, AlbertHeijnOptions options)
    {
        var detail = RequireDetail(root);

        string? method = null;
        var largest = 0L;

        foreach (var payment in JsonAccess.Array(detail, "payments"))
        {
            var stated = Normalize(JsonAccess.StrOf(payment, "method"));
            if (stated is null) continue;

            // split tender: the largest leg is the one a bank transaction matches
            var amount = MoneyReader.Optional(payment, options.PaymentAmountUnit, options.Currency,
                "payment.amount", "amount")?.Abs().Value ?? 0L;

            if (method is not null && amount <= largest) continue;

            method = stated;
            largest = amount;
        }

        return ReceiptFactory.Payment(method);
    }

    public static Merchant Merchant(string? storeName) => new()
    {
        Id = ProviderId,
        Name = "Albert Heijn",
        StoreName = storeName,
    };

    private static JsonElement RequireDetail(JsonElement root)
    {
        if (!TryField(root, "posReceiptDetails", out var detail) || detail.ValueKind != JsonValueKind.Object)
        {
            // not an empty receipt: the list named it, so a denied detail is a shape change
            throw ConnectorException.ProviderChanged($"{ProviderId}: the detail carries no posReceiptDetails");
        }

        return detail;
    }

    /// exact and case-sensitive, no aliases: a GraphQL response only has the names the query asked for.
    /// A JSON null is returned, not skipped: "page is null" (empty history) differs from "no such field" (broken).
    private static bool TryField(JsonElement root, string name, out JsonElement value)
    {
        value = root.Child("data").Child(name);
        if (value.ValueKind != JsonValueKind.Undefined) return true;

        value = root.Child(name);
        return value.ValueKind != JsonValueKind.Undefined;
    }

    /// <summary>Provider payment words mapped onto the four the schema allows.</summary>
    private static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        if (raw.Contains("cash", StringComparison.OrdinalIgnoreCase) ||
            raw.Contains("contant", StringComparison.OrdinalIgnoreCase))
        {
            return "cash";
        }

        if (raw.Contains("ideal", StringComparison.OrdinalIgnoreCase)) return "ideal";

        return raw.Contains("card", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("pin", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("maestro", StringComparison.OrdinalIgnoreCase)
            ? "card"
            : "other";
    }
}
