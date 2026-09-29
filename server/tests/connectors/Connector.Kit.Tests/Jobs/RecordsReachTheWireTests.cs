using System.Collections;
using System.Reflection;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests;

/// <summary>
/// Every normalised record has to survive the whole way out: an adapter
/// produces it, <see cref="FetchResult"/> carries it, the wire carries it, and
/// staging writes it down. Miss any one of those and the record is invisible.
///
/// This exists because that is not hypothetical. <see cref="StudentDebt"/>
/// shipped with a record type, a resource shape, a schema in the API document,
/// an adapter that built one correctly and tests that proved it - and no list
/// on <see cref="JobResultRequest"/>. The fetch ran, answered "complete", and
/// staged nothing. What the account holder saw was "0 student-debt", which
/// reads as "you have no student debt" rather than as a defect, on a page whose
/// whole job is to state what somebody owes.
///
/// A silence is the worst failure this platform has: an error is diagnosable
/// and an empty result looks like an answer.
/// </summary>
public sealed class RecordsReachTheWireTests
{
    /// <summary>The record behind every declared resource shape.</summary>
    public static TheoryData<string> RecordTypes()
    {
        var data = new TheoryData<string>();
        foreach (var record in RecordShapes.All.Values) data.Add(record.FullName!);

        return data;
    }

    [Theory]
    [MemberData(nameof(RecordTypes))]
    public void Every_record_shape_can_be_carried_by_a_fetch_result(string recordTypeName)
    {
        AssertCarries(typeof(FetchResult), recordTypeName);
    }

    /// <summary>
    /// The step that was missing. A record an adapter can produce but the wire
    /// cannot carry reaches the control plane as nothing at all.
    /// </summary>
    [Theory]
    [MemberData(nameof(RecordTypes))]
    public void Every_record_shape_can_be_carried_on_the_wire(string recordTypeName)
    {
        AssertCarries(typeof(JobResultRequest), recordTypeName);
    }

    [Fact]
    public void The_shapes_being_checked_are_not_an_empty_set()
    {
        // Guards both theories: an empty table would make each of them pass by
        // never running, which is the same class of silence they exist to
        // catch.
        Assert.NotEmpty(RecordShapes.All);
        Assert.Equal(Enum.GetValues<ResourceShape>().Length, RecordShapes.All.Count);
    }

    private static void AssertCarries(Type carrier, string recordTypeName)
    {
        var carried = carrier
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => p.PropertyType)
            .Where(t => t.IsGenericType && typeof(IEnumerable).IsAssignableFrom(t))
            .Select(t => t.GetGenericArguments().FirstOrDefault()?.FullName)
            .Where(n => n is not null)
            .ToList();

        Assert.True(
            carried.Contains(recordTypeName),
            $"{carrier.Name} carries no list of {recordTypeName}, so a record of that shape is dropped " +
            "silently on its way out. Add the list, pass it through both job runners, and stage it.");
    }
}
