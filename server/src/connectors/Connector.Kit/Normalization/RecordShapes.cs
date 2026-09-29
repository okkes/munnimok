using Connector.Kit.Manifests;

namespace Connector.Kit.Normalization;

/// <summary>
/// Which record a resource's <see cref="ResourceShape"/> actually means.
///
/// The link existed only in prose before this: a manifest said
/// <c>returns: "receipt"</c>, a caller was expected to know that a receipt has
/// a merchant and lines and a possibly-derived total, and nothing anywhere
/// stated it. The API document described the fetch response as an array of
/// anything, so the honest answer to "what will I get back" was "fetch it and
/// look" - which is not an answer a consumer can write a mapping against, and
/// not one it can write before it has a real account to fetch from.
///
/// This is the table that closes it. The document generator walks it to
/// publish a schema per shape, so <c>returns</c> resolves to a real model in
/// the reference, and a shape with no record fails a test instead of becoming
/// a promise nothing keeps.
/// </summary>
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

    /// <summary>Every shape and the record behind it, in declaration order.</summary>
    public static IReadOnlyDictionary<ResourceShape, Type> All => Records;

    /// <summary>
    /// The record a shape means.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// The shape has no record. Thrown rather than returning null because
    /// there is no sensible fallback: a resource whose rows have no declared
    /// type is one no consumer can read.
    /// </exception>
    public static Type Require(ResourceShape shape) =>
        Records.TryGetValue(shape, out var record)
            ? record
            : throw new InvalidOperationException($"resource shape '{shape}' has no normalised record");
}
