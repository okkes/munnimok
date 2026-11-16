namespace Munni.Api.Splits;

public sealed record SettlementPayment(Guid From, Guid To, long Cents);

/// #538: the fewest payments that bring everybody to zero: people with something open minus the groups that cancel
/// out by themselves; a group of k settles in k − 1. Past <see cref="ExactLimit"/> open people the plan pairs the
/// largest debt with the largest claim.
public static class SplitSettlement
{
    /// 2^18 subsets is instant; each further person doubles it
    public const int ExactLimit = 18;

    public static Dictionary<Guid, long> Balances(IEnumerable<(Guid PaidBy, long AmountCents, IReadOnlyList<SplitShareDto> Shares)> entries)
    {
        var balances = new Dictionary<Guid, long>();
        foreach (var (paidBy, amount, shares) in entries)
        {
            balances[paidBy] = balances.GetValueOrDefault(paidBy) + amount;
            foreach (var share in shares) balances[share.UserId] = balances.GetValueOrDefault(share.UserId) - share.Cents;
        }
        return balances;
    }

    /// balances must cancel out: they do when every entry's shares add up to its amount
    public static List<SettlementPayment> Plan(IReadOnlyDictionary<Guid, long> balances)
    {
        // a stable order: the same balances always give the same plan
        var open = balances.Where(b => b.Value != 0).OrderBy(b => b.Key).Select(b => (User: b.Key, Cents: b.Value)).ToList();
        if (open.Sum(b => b.Cents) != 0) throw new InvalidOperationException("balances do not cancel out");
        var payments = new List<SettlementPayment>();
        foreach (var group in open.Count <= ExactLimit ? CancellingGroups(open) : [open]) payments.AddRange(PairOff(group));
        return [.. payments.OrderByDescending(p => p.Cents).ThenBy(p => p.From).ThenBy(p => p.To)];
    }

    /// best[set] = the most cancelling groups inside the set; a set that sums to zero closes one more group
    private static List<List<(Guid User, long Cents)>> CancellingGroups(List<(Guid User, long Cents)> open)
    {
        var count = open.Count;
        if (count == 0) return [];
        var size = 1 << count;
        var sum = new long[size];
        var best = new int[size];
        var via = new int[size];
        for (var set = 1; set < size; set++)
        {
            var low = int.TrailingZeroCount(set);
            sum[set] = sum[set & (set - 1)] + open[low].Cents;
            best[set] = -1;
            for (var person = 0; person < count; person++)
            {
                if ((set & (1 << person)) == 0) continue;
                var rest = set & ~(1 << person);
                if (best[rest] > best[set])
                {
                    best[set] = best[rest];
                    via[set] = rest;
                }
            }
            if (sum[set] == 0) best[set] += 1;
        }
        return Peel(open, sum, via);
    }

    private static List<List<(Guid User, long Cents)>> Peel(List<(Guid User, long Cents)> open, long[] sum, int[] via)
    {
        var groups = new List<List<(Guid User, long Cents)>>();
        var everybody = (1 << open.Count) - 1;
        var closing = everybody;
        for (var set = everybody; set != 0; set = via[set])
        {
            var next = via[set];
            if (next != 0 && sum[next] != 0) continue;
            groups.Add(Members(open, closing & ~next));
            closing = next;
        }
        return groups;
    }

    private static List<(Guid User, long Cents)> Members(List<(Guid User, long Cents)> open, int set)
    {
        var members = new List<(Guid User, long Cents)>();
        for (var person = 0; person < open.Count; person++)
        {
            if ((set & (1 << person)) != 0) members.Add(open[person]);
        }
        return members;
    }

    private static IEnumerable<SettlementPayment> PairOff(List<(Guid User, long Cents)> group)
    {
        var debts = new PriorityQueue<Guid, (long, Guid)>();
        var claims = new PriorityQueue<Guid, (long, Guid)>();
        foreach (var (user, cents) in group)
        {
            // the largest first, the id deciding between equals
            if (cents < 0) debts.Enqueue(user, (cents, user));
            else claims.Enqueue(user, (-cents, user));
        }
        while (debts.TryDequeue(out var debtor, out var debt) && claims.TryDequeue(out var creditor, out var claim))
        {
            var owes = -debt.Item1;
            var isOwed = -claim.Item1;
            var pays = Math.Min(owes, isOwed);
            yield return new SettlementPayment(debtor, creditor, pays);
            if (owes > pays) debts.Enqueue(debtor, (-(owes - pays), debtor));
            if (isOwed > pays) claims.Enqueue(creditor, (-(isOwed - pays), creditor));
        }
    }
}
