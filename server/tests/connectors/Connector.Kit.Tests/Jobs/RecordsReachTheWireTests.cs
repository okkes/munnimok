using System.Collections;
using System.Reflection;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests;

// a record an adapter produces but FetchResult or JobResultRequest cannot carry is dropped silently: StudentDebt shipped
// without a list on JobResultRequest and staged nothing, which read as "no student debt"; silence is the worst failure
public sealed class RecordsReachTheWireTests
{
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

    [Theory]
    [MemberData(nameof(RecordTypes))]
    public void Every_record_shape_can_be_carried_on_the_wire(string recordTypeName)
    {
        AssertCarries(typeof(JobResultRequest), recordTypeName);
    }

    [Fact]
    public void The_shapes_being_checked_are_not_an_empty_set()
    {
        // an empty table would make both theories pass by never running
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
