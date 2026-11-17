using System.Text.Json;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests.Normalization;

// the Try accessors throw on a wrong-kind element (four of ten adapters made that mistake).
// these tests hold that the raw API throws and nothing here does
public sealed class JsonReadTests
{
    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    // asserted so a runtime that makes these return false is noticed; InvalidOperationException is no JsonException,
    // so it passes every catch and surfaces as an internal error: retriable, blamed on us, fatal to a whole fetch
    [Fact]
    public void The_runtimes_own_try_methods_throw_rather_than_answering_false()
    {
        var notAnObject = Parse("null");
        var notANumber = Parse("\"12\"");

        Assert.Throws<InvalidOperationException>(() => notAnObject.TryGetProperty("x", out _));
        Assert.Throws<InvalidOperationException>(() => notANumber.TryGetInt32(out _));
        Assert.Throws<InvalidOperationException>(() => notANumber.TryGetInt64(out _));
        Assert.Throws<InvalidOperationException>(() => notANumber.TryGetDecimal(out _));
    }

    // null really happens: GraphQL sends it for a non-nullable child that errored, and DUO's fixtures carry explicit nulls
    // on number fields
    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("[1,2,3]")]
    [InlineData("\"a string\"")]
    [InlineData("12")]
    [InlineData("true")]
    public void Nothing_throws_on_a_payload_that_is_not_an_object(string json)
    {
        var element = Parse(json);

        Assert.Equal(JsonValueKind.Undefined, element.Child("anything").ValueKind);
        Assert.False(element.Has("anything", out _));
        Assert.Null(element.Text("anything"));
        Assert.Null(element.Int32("anything"));
        Assert.Null(element.Int64("anything"));
        Assert.Null(element.Decimal("anything"));
        Assert.False(element.Flag("anything"));
        Assert.Empty(element.Items("anything"));
    }

    // a number where a string is expected is drift; answering with its digits would hide it
    [Fact]
    public void A_child_of_the_wrong_kind_reads_as_absent()
    {
        var row = Parse("""{"name":42,"count":"7","when":null,"flag":"true","links":{}}""");

        Assert.Null(row.Text("name"));
        Assert.Null(row.Int32("count"));
        Assert.Null(row.Int64("count"));
        Assert.Null(row.Decimal("count"));
        Assert.Null(row.Int32("when"));
        Assert.False(row.Flag("flag"));
        Assert.Empty(row.Items("links"));
    }

    // ING's credit card states id as "" on every row: present, worth nothing, past a null check
    [Fact]
    public void A_blank_string_reads_as_absent_and_a_padded_one_is_trimmed()
    {
        var row = Parse("""{"id":"","space":"   ","subject":"  Incasso ING creditcard   "}""");

        Assert.Null(row.Text("id"));
        Assert.Null(row.Text("space"));
        Assert.Equal("Incasso ING creditcard", row.Text("subject"));
    }

    // an explicit null means the provider has no value, like an absent field
    [Fact]
    public void Has_tells_a_stated_null_apart_from_a_stated_value()
    {
        var row = Parse("""{"stated":{"a":1},"empty":null,"blank":""}""");

        Assert.True(row.Has("stated", out var stated));
        Assert.Equal(JsonValueKind.Object, stated.ValueKind);

        Assert.False(row.Has("empty", out _));
        Assert.False(row.Has("missing", out _));

        // blank is present: only Text() judges emptiness; Has() asks whether the provider stated something
        Assert.True(row.Has("blank", out _));
    }

    [Fact]
    public void An_undefined_child_can_be_read_straight_through()
    {
        var row = Parse("""{"a":{"b":{"c":"deep"}}}""");

        Assert.Equal("deep", row.Child("a").Child("b").Text("c"));
        Assert.Null(row.Child("nope").Child("nor this").Text("c"));
    }

    // only the literal true: a flag decides whether a row is published (ING skips reservation: true),
    // so "true", 1 and "yes" must not change a statement
    [Fact]
    public void A_flag_is_the_json_literal_and_nothing_that_resembles_it()
    {
        var row = Parse("""{"yes":true,"no":false,"worded":"true","numbered":1}""");

        Assert.True(row.Flag("yes"));
        Assert.False(row.Flag("no"));
        Assert.False(row.Flag("worded"));
        Assert.False(row.Flag("numbered"));
    }

    // GraphQL sends null in an array when a non-nullable child errors; it must cost the row, not the page of orders
    [Fact]
    public void An_array_with_a_hole_in_it_costs_the_row_and_not_the_page()
    {
        var page = Parse("""{"items":[{"id":"a"},null,{"id":"b"}]}""");

        Assert.Equal(3, page.Items("items").Count());

        var read = page.Items("items").Objects().Select(item => item.Text("id")).ToList();

        Assert.Equal(["a", "b"], read);
    }

    /// <summary>Exact names, so a rename is reported rather than absorbed.</summary>
    [Fact]
    public void A_name_that_differs_only_in_case_is_a_different_name()
    {
        var row = Parse("""{"accountId":"NL01"}""");

        Assert.Equal("NL01", row.Text("accountId"));
        Assert.Null(row.Text("accountid"));
        Assert.Null(row.Text("AccountId"));
    }

    // a decimal read via a double would lose money's precision
    [Fact]
    public void A_decimal_is_read_as_a_decimal()
    {
        var row = Parse("""{"balance":1730.01,"long":9007199254740993}""");

        Assert.Equal(1730.01m, row.Decimal("balance"));

        // past 2^53 a double cannot tell two integers apart
        Assert.Equal(9007199254740993L, row.Int64("long"));

        Assert.Null(row.Int32("long"));
    }
}
