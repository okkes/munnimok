using System.Text.Json;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests.Normalization;

/// <summary>
/// The reader that exists because <c>Try</c> does not mean what it says.
///
/// An audit of ten adapters found this same mistake in four of them, written by
/// different hands at different times, and every one of them read as correct.
/// These tests hold both halves of the reason: that the raw API really does
/// throw, and that nothing here does.
/// </summary>
public sealed class JsonReadTests
{
    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    /// <summary>
    /// THE HAZARD ITSELF, ASSERTED.
    /// </summary>
    /// <remarks>
    /// Written as a test rather than as a comment because it is the whole
    /// premise: if a future runtime made these return false, this file could be
    /// deleted, and nobody would find that out by reading the docs. It fails
    /// loudly on the day the assumption changes.
    /// <para>
    /// Note WHICH exception. <see cref="InvalidOperationException"/> is not a
    /// <see cref="JsonException"/>, so it walks past every catch written for
    /// "the provider sent something unreadable" and surfaces as an internal
    /// error - retriable, blamed on us, and fatal to a whole fetch.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// And every kind a provider can send answers "not there" instead.
    /// </summary>
    /// <remarks>
    /// <c>null</c> is the one that actually happens - a GraphQL server sends it
    /// for any non-nullable child that errored, and DUO's own fixtures carry
    /// explicit nulls on number-typed fields - but a reader that handled only
    /// the observed shape would be one payload away from the same failure.
    /// </remarks>
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

    /// <summary>
    /// A field of the wrong kind is not the field. A number where a string was
    /// expected is drift, and answering with its digits would hide it.
    /// </summary>
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

    /// <summary>
    /// BLANK IS NOT A VALUE. ING's credit card states <c>id</c> as an empty
    /// string on every row - present, worth nothing, and past a null check.
    /// </summary>
    [Fact]
    public void A_blank_string_reads_as_absent_and_a_padded_one_is_trimmed()
    {
        var row = Parse("""{"id":"","space":"   ","subject":"  Incasso ING creditcard   "}""");

        Assert.Null(row.Text("id"));
        Assert.Null(row.Text("space"));
        Assert.Equal("Incasso ING creditcard", row.Text("subject"));
    }

    /// <summary>
    /// An explicit null is not "present". A provider stating a field as null is
    /// saying it has no value for it, exactly as an absent field does.
    /// </summary>
    [Fact]
    public void Has_tells_a_stated_null_apart_from_a_stated_value()
    {
        var row = Parse("""{"stated":{"a":1},"empty":null,"blank":""}""");

        Assert.True(row.Has("stated", out var stated));
        Assert.Equal(JsonValueKind.Object, stated.ValueKind);

        Assert.False(row.Has("empty", out _));
        Assert.False(row.Has("missing", out _));

        // Blank IS present - it is a string, and only Text() judges its
        // emptiness. Has() answers about the provider's intent to state
        // something, which is a different question.
        Assert.True(row.Has("blank", out _));
    }

    /// <summary>
    /// A chain of missing children is walkable without a guard at each step,
    /// which is what makes the safe form shorter than the unsafe one.
    /// </summary>
    [Fact]
    public void An_undefined_child_can_be_read_straight_through()
    {
        var row = Parse("""{"a":{"b":{"c":"deep"}}}""");

        Assert.Equal("deep", row.Child("a").Child("b").Text("c"));
        Assert.Null(row.Child("nope").Child("nor this").Text("c"));
    }

    /// <summary>
    /// ONLY THE LITERAL TRUE. A flag decides whether a row is published at all -
    /// ING skips a transaction on <c>reservation: true</c> - so "true", 1 and
    /// "yes" must not quietly change what a statement contains.
    /// </summary>
    [Fact]
    public void A_flag_is_the_json_literal_and_nothing_that_resembles_it()
    {
        var row = Parse("""{"yes":true,"no":false,"worded":"true","numbered":1}""");

        Assert.True(row.Flag("yes"));
        Assert.False(row.Flag("no"));
        Assert.False(row.Flag("worded"));
        Assert.False(row.Flag("numbered"));
    }

    /// <summary>
    /// THE ONE THAT WOULD HAVE CAUGHT IT: an array with a null in it.
    /// </summary>
    /// <remarks>
    /// This is not a hypothetical shape. GraphQL sends it whenever a
    /// non-nullable child errors, and the cost of walking into it was a page of
    /// orders rather than the one row the provider could not render.
    /// </remarks>
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

    /// <summary>
    /// Money keeps its precision. A decimal read that had been through a double
    /// would be a balance nobody could reason about afterwards.
    /// </summary>
    [Fact]
    public void A_decimal_is_read_as_a_decimal()
    {
        var row = Parse("""{"balance":1730.01,"long":9007199254740993}""");

        Assert.Equal(1730.01m, row.Decimal("balance"));

        // Past 2^53, where a double stops being able to tell two integers
        // apart.
        Assert.Equal(9007199254740993L, row.Int64("long"));

        // And a value that does not fit answers null rather than wrapping.
        Assert.Null(row.Int32("long"));
    }
}
