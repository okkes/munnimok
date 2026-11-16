using Connector.Kit.Manifests;

namespace Connector.Kit.Normalization;

// the table behind a manifest's `returns`: the document generator publishes a schema per shape,
// and a shape with no record fails a test
public static class RecordShapes
{
    private static readonly Dictionary<ResourceShape, Type> Records = new()
    {
        [ResourceShape.Account] = typeof(Account),
        [ResourceShape.Transaction] = typeof(Transaction),
        [ResourceShape.Receipt] = typeof(Receipt),
        [ResourceShape.CreditRegistration] = typeof(CreditRegistration),
        [ResourceShape.StudentDebt] = typeof(StudentDebt),
    };

    public static IReadOnlyDictionary<ResourceShape, Type> All => Records;

    // throws rather than returning null: a resource whose rows have no declared type is one no consumer can read
    public static Type Require(ResourceShape shape) =>
        Records.TryGetValue(shape, out var record)
            ? record
            : throw new InvalidOperationException($"resource shape '{shape}' has no normalised record");
}
