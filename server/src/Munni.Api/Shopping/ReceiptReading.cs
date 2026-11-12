using System.Collections.Concurrent;
using System.Globalization;

namespace Munni.Api.Shopping;

/// <summary>A category the reader may file a line under — the person's own list, by id and name.</summary>
public sealed record ReadCategory(string Id, string Name);

/// <summary>One photo of the receipt as it was sent.</summary>
public sealed record ReceiptPhoto(byte[] Bytes, string MediaType);

/// <summary>
/// One line as a reader gives it, before the API has checked anything:
/// <c>Kind</c> is item, discount, deposit or fee; money is in cents.
/// </summary>
public sealed record ReadLine(string? Name, decimal? Quantity, int? UnitCents, int? TotalCents, string? Kind, string? CategoryId);

/// <summary>A receipt as a reader gives it.</summary>
public sealed record ReadReceipt(string? Merchant, string? Date, string? Currency, int? TotalCents, IReadOnlyList<ReadLine>? Lines);

/// <summary>
/// Reads the photos of one receipt (#567). The provider behind it is the
/// operator's choice in the setup wizard; null means it could not read
/// them — a refusal, an answer that is no receipt, a provider that is away.
/// </summary>
public interface IReceiptReader
{
    string Provider { get; }

    /// <summary>The model a read runs on when the operator named none.</summary>
    string DefaultModel { get; }

    /// <param name="model">the operator's choice in the admin portal; null = the provider's default</param>
    Task<ReadReceipt?> ReadAsync(IReadOnlyList<ReceiptPhoto> photos, IReadOnlyList<ReadCategory> categories, string? model, CancellationToken ct);
}

/// <summary>A line the app can show and file: checked, trimmed, in whole cents.</summary>
public sealed record ReceiptLine(string Name, decimal Quantity, int UnitCents, int TotalCents, string Kind, string? CategoryId);

/// <summary>The receipt the app gets back. <c>Reconciled</c>: the lines add up to the total.</summary>
public sealed record ReceiptReadResult(string? Merchant, string? Date, string? Currency, int TotalCents, IReadOnlyList<ReceiptLine> Lines, bool Reconciled);

/// <summary>
/// The API's own check of what a reader said (user: "munni api validates
/// totals, normalizes keys, match categories"): nothing a model wrote is
/// trusted to add up, to name a real category, or to be a date.
/// </summary>
public static class ReceiptReadCheck
{
    public const int MaxLines = 200;
    public const int MaxNameLength = 120;
    private static readonly string[] Kinds = ["item", "discount", "deposit", "fee"];

    public static ReceiptReadResult? Normalize(ReadReceipt? read, IReadOnlyList<ReadCategory> categories)
    {
        if (read?.Lines is null) return null;
        var known = categories.Select(c => c.Id).ToHashSet(StringComparer.Ordinal);
        var lines = read.Lines.Take(MaxLines).Select(l => Line(l, known)).OfType<ReceiptLine>().ToList();
        if (lines.Count == 0) return null;

        var sum = lines.Sum(l => l.TotalCents);
        // a receipt without a printed total is worth what its lines are
        var total = read.TotalCents is { } printed and > 0 ? printed : sum;
        return new ReceiptReadResult(Text(read.Merchant, 80), Day(read.Date), Currency(read.Currency), total, lines, sum == total);
    }

    private static ReceiptLine? Line(ReadLine line, HashSet<string> known)
    {
        var name = Text(line.Name, MaxNameLength);
        if (name is null || line.TotalCents is not { } total) return null;
        var kind = Kinds.Contains(line.Kind) ? line.Kind! : "item";
        // a discount takes off, whatever sign the reader gave it; the rest is never negative
        var cents = kind == "discount" ? -Math.Abs(total) : Math.Abs(total);
        var quantity = line.Quantity is { } q and > 0 and < 10_000 ? q : 1m;
        var unit = line.UnitCents is { } u and > 0 ? u : (int)Math.Round(Math.Abs(cents) / quantity, MidpointRounding.AwayFromZero);
        var category = kind == "item" && line.CategoryId is { } id && known.Contains(id) ? id : null;
        return new ReceiptLine(name, quantity, unit, cents, kind, category);
    }

    private static string? Text(string? value, int max)
    {
        var text = string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (text.Length == 0) return null;
        return text.Length <= max ? text : text[..max];
    }

    private static string? Day(string? value) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;

    private static string? Currency(string? value)
    {
        var code = value?.Trim().ToUpperInvariant();
        return code is { Length: 3 } && code.All(char.IsAsciiLetterUpper) ? code : null;
    }
}

/// <summary>
/// How many receipts were read (#567): per person per day in memory — a
/// restart forgets a day's count, which costs a few reads at most — and
/// per month for the whole environment, which the endpoint keeps in the
/// database so a restart cannot reopen a month the operator capped.
/// </summary>
public sealed class ReceiptReadCounts(TimeProvider time)
{
    private readonly ConcurrentDictionary<(Guid User, DateOnly Day), int> _today = new();

    public DateTimeOffset Now => time.GetUtcNow();

    public DateTimeOffset Tomorrow => new(Now.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);

    public DateTimeOffset NextMonth
    {
        get
        {
            var first = new DateTime(Now.Year, Now.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(1);
            return new DateTimeOffset(first, TimeSpan.Zero);
        }
    }

    public string MonthKey => Now.ToString("yyyy-MM", CultureInfo.InvariantCulture);

    /// <summary>Counts one read for a person; false when today's are used up (no limit: always true).</summary>
    public bool TrySpend(Guid user, int? dailyLimit)
    {
        var key = (user, DateOnly.FromDateTime(Now.UtcDateTime));
        foreach (var stale in _today.Keys.Where(k => k.Day < key.Item2).ToList()) _today.TryRemove(stale, out _);
        while (true)
        {
            var used = _today.GetOrAdd(key, 0);
            if (dailyLimit is { } limit && used >= limit) return false;
            if (_today.TryUpdate(key, used + 1, used)) return true;
        }
    }

    /// <summary>A read that came to nothing does not count against the person.</summary>
    public void Refund(Guid user)
    {
        var key = (user, DateOnly.FromDateTime(Now.UtcDateTime));
        _today.AddOrUpdate(key, 0, (_, used) => Math.Max(0, used - 1));
    }
}
