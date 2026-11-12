using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Anthropic;
using Anthropic.Models.Beta.Messages;

namespace Munni.Api.Shopping;

/// <summary>
/// The receipt reader on Claude (#567): the photos and the person's
/// category list go in, a schema-bound JSON answer comes out. Nothing here
/// decides anything about money — the API checks every figure afterwards
/// (ReceiptReadCheck).
/// </summary>
public sealed class ClaudeReceiptReader(AnthropicClient client) : IReceiptReader
{
    public const string Model = "claude-opus-5-5";
    private const string FallbackBeta = "server-side-fallback-2026-07-01";

    /// <summary>The models whose declined requests the API can hand to another model inside the same call.</summary>
    private static readonly string[] FallbackModels = ["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

    private const string Instructions =
        """
        You read photos of ONE shop receipt and return what is printed on it as data. Several photos are parts of the same long receipt, in order.

        Copy what the receipt says. Do not compute, round or correct anything; the caller checks the sums.

        - Money is in cents, as whole numbers: 12.50 is 1250.
        - lines: every line of the purchase, in the order printed. Leave out subtotals, VAT summaries, payment, change and loyalty-point lines.
        - kind: "item" for a product; "discount" for a discount, bonus or coupon line, with total_cents the amount it takes off as a positive number; "deposit" for a deposit such as statiegeld; "fee" for a bag, service or delivery charge.
        - quantity and unit_cents when the receipt shows them (2 x 1.99, or 0.456 kg at 2.99 per kg gives quantity 0.456 and unit_cents 299); otherwise null.
        - total_cents: what the line adds to the receipt.
        - category_id: for an item, the id from the category list that fits it best; null when none fits or the line is not an item. Use only ids from the list.
        - merchant: the shop's name as a person would say it. date: the day of the purchase as yyyy-mm-dd. currency: the ISO code when the receipt shows a currency (the euro sign is EUR). total_cents: the total that was paid.
        - A field the receipt does not show is null. If the photos show no receipt, return an empty lines array.
        """;

    private static readonly Dictionary<string, JsonElement> Schema = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(
        """
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["merchant", "date", "currency", "total_cents", "lines"],
          "properties": {
            "merchant": { "type": ["string", "null"] },
            "date": { "type": ["string", "null"] },
            "currency": { "type": ["string", "null"] },
            "total_cents": { "type": ["integer", "null"] },
            "lines": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["name", "quantity", "unit_cents", "total_cents", "kind", "category_id"],
                "properties": {
                  "name": { "type": "string" },
                  "quantity": { "type": ["number", "null"] },
                  "unit_cents": { "type": ["integer", "null"] },
                  "total_cents": { "type": "integer" },
                  "kind": { "type": "string", "enum": ["item", "discount", "deposit", "fee"] },
                  "category_id": { "type": ["string", "null"] }
                }
              }
            }
          }
        }
        """)!;

    private sealed record AnswerLine(
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("quantity")] decimal? Quantity,
        [property: JsonPropertyName("unit_cents")] int? UnitCents,
        [property: JsonPropertyName("total_cents")] int? TotalCents,
        [property: JsonPropertyName("kind")] string? Kind,
        [property: JsonPropertyName("category_id")] string? CategoryId);

    private sealed record Answer(
        [property: JsonPropertyName("merchant")] string? Merchant,
        [property: JsonPropertyName("date")] string? Date,
        [property: JsonPropertyName("currency")] string? Currency,
        [property: JsonPropertyName("total_cents")] int? TotalCents,
        [property: JsonPropertyName("lines")] List<AnswerLine>? Lines);

    public string Provider => "anthropic";

    public string DefaultModel => Model;

    public async Task<ReadReceipt?> ReadAsync(IReadOnlyList<ReceiptPhoto> photos, IReadOnlyList<ReadCategory> categories, string? model, CancellationToken ct)
    {
        var chosen = string.IsNullOrWhiteSpace(model) ? Model : model;
        List<BetaContentBlockParam> content = [];
        foreach (var photo in photos)
        {
            content.Add(new BetaImageBlockParam
            {
                Source = new BetaBase64ImageSource { Data = Convert.ToBase64String(photo.Bytes), MediaType = photo.MediaType },
            });
        }
        content.Add(new BetaTextBlockParam { Text = CategoryList(categories) });

        var fallback = FallbackModels.Contains(chosen);
        var response = await client.Beta.Messages.Create(
            new MessageCreateParams
            {
                Model = chosen,
                MaxTokens = 16000,
                System = Instructions,
                // a declined request is re-run on another model inside the same call, where the model offers that
                Betas = fallback ? [FallbackBeta] : null,
                Fallbacks = fallback ? (BetaFallbacksParam)new Default() : null,
                OutputConfig = new BetaOutputConfig { Effort = Effort.Low, Format = new BetaJsonOutputFormat { Schema = Schema } },
                Messages = [new BetaUserMessageParam { Content = content }],
            },
            cancellationToken: ct);

        // declined, or cut off before the JSON closed: no receipt to give
        if (response.StopReason == "refusal" || response.StopReason == "max_tokens") return null;
        var json = new StringBuilder();
        foreach (var block in response.Content)
        {
            if (block.TryPickText(out var text)) json.Append(text.Text);
        }
        return Parse(json.ToString());
    }

    /// <summary>The person's categories as the reader sees them: one "id — name" per line.</summary>
    internal static string CategoryList(IReadOnlyList<ReadCategory> categories)
    {
        if (categories.Count == 0) return "There is no category list: every category_id is null.";
        var list = new StringBuilder("Categories (id — name):\n");
        foreach (var category in categories) list.Append("- ").Append(category.Id).Append(" — ").Append(category.Name).Append('\n');
        return list.ToString();
    }

    /// <summary>The model's answer as the reader's contract; null when it is no JSON of the agreed shape.</summary>
    internal static ReadReceipt? Parse(string json)
    {
        try
        {
            var answer = JsonSerializer.Deserialize<Answer>(json);
            if (answer is null) return null;
            var lines = (answer.Lines ?? []).Select(l => new ReadLine(l.Name, l.Quantity, l.UnitCents, l.TotalCents, l.Kind, l.CategoryId)).ToList();
            return new ReadReceipt(answer.Merchant, answer.Date, answer.Currency, answer.TotalCents, lines);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
