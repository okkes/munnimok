using System.Globalization;
using System.Text.Json;
using Connector.Kit.Challenges;
using Xunit;

namespace Connector.Kit.Tests;

// a disagreement between the two ends is a click at a point no human chose, in a real account, so the encoding is pinned:
// fractions of the image never pixels, the human's order, "done" said explicitly, a text answer never mistaken for taps
public sealed class ChallengeAnswerKindTests
{
    private static Challenge Grid() => new()
    {
        Type = ChallengeType.Image,
        AnswerKind = ChallengeAnswerKind.Taps,
        ExpiresAt = TestTime.Anchor.AddMinutes(5),
    };

    [Fact]
    public void A_challenge_is_answered_in_text_unless_it_says_otherwise()
    {
        // the default keeps this addition invisible to every earlier adapter and consumer
        var mfa = new Challenge { Type = ChallengeType.MfaCode, ExpiresAt = TestTime.Anchor.AddMinutes(3) };

        Assert.Equal(ChallengeAnswerKind.Text, mfa.AnswerKind);
        Assert.Equal(ChallengeAnswerKind.Taps, Grid().AnswerKind);
    }

    [Fact]
    public void A_payload_that_never_heard_of_answer_kinds_is_a_text_challenge()
    {
        var json = """{"type":"image","expires_at":"2026-07-27T10:00:00+00:00"}""";

        var challenge = JsonSerializer.Deserialize<Challenge>(json, ConnectorWireJson.Options);

        Assert.NotNull(challenge);
        Assert.Equal(ChallengeAnswerKind.Text, challenge.AnswerKind);
    }

    [Fact]
    public void The_answer_kind_crosses_the_wire_by_name()
    {
        // a client renders a tappable image off this field: published surface, not an internal hint
        var json = JsonSerializer.Serialize(Grid(), ConnectorWireJson.Options);

        Assert.Contains("\"answer_kind\":\"taps\"", json, StringComparison.Ordinal);
        Assert.Equal(
            ChallengeAnswerKind.Taps,
            JsonSerializer.Deserialize<Challenge>(json, ConnectorWireJson.Options)?.AnswerKind);
    }

    [Fact]
    public void A_text_challenge_behaves_exactly_as_it_did_before()
    {
        var mfa = new Challenge
        {
            Type = ChallengeType.MfaCode,
            Delivery = "sms",
            Length = 6,
            ExpiresAt = TestTime.Anchor.AddMinutes(3),
        };

        var answer = new ChallengeAnswer { ChallengeId = "chl_1", Value = "492013" };

        Assert.False(mfa.IsPassive);
        Assert.False(mfa.IsExpired(TestTime.Anchor));
        Assert.Equal("492013", answer.Value);

        Assert.False(TapAnswer.TryParse(answer.Value, out _));
    }

    [Fact]
    public void A_passive_challenge_still_answers_with_nothing_at_all()
    {
        var approval = new Challenge { Type = ChallengeType.AppApproval, ExpiresAt = TestTime.Anchor.AddMinutes(3) };

        Assert.True(approval.IsPassive);
        Assert.Equal(ChallengeAnswerKind.Text, approval.AnswerKind);
        Assert.Equal(string.Empty, new ChallengeAnswer { ChallengeId = "chl_1" }.Value);
    }

    [Fact]
    public void Taps_round_trip_in_the_order_the_human_made_them()
    {
        // order is information the client has and a drop loses: some grids ask for tiles in sequence
        var answered = new TapAnswer
        {
            Taps = [new Tap(0.8333, 0.1667), new Tap(0.1667, 0.5), new Tap(0.5, 0.8333)],
            Submit = true,
        };

        Assert.True(TapAnswer.TryParse(answered.Format(), out var back));
        Assert.Equal(answered.Taps, back.Taps);
        Assert.True(back.Submit);
        Assert.Equal(answered.Format(), back.Format());
    }

    [Fact]
    public void The_encoding_is_the_one_both_ends_were_told_about()
    {
        // pinned literally: the client formats this string without linking the kit, so a change is a published-format change
        Assert.Equal(
            "tap.v1:0.25,0.5;submit",
            new TapAnswer { Taps = [new Tap(0.25, 0.5)], Submit = true }.Format());

        Assert.Equal("tap.v1:0.25,0.5", new TapAnswer { Taps = [new Tap(0.25, 0.5)] }.Format());
    }

    [Theory]
    [InlineData(1.0001)]
    [InlineData(-0.0001)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void A_coordinate_outside_the_image_is_not_a_coordinate(double bad)
    {
        // pixels where fractions belong (a phone reporting 412 for x) must fail loudly, not clip to an edge and click the wrong tile
        Assert.Throws<ArgumentOutOfRangeException>(() => new Tap(bad, 0.5));
        Assert.Throws<ArgumentOutOfRangeException>(() => new Tap(0.5, bad));
    }

    [Fact]
    public void The_edges_of_the_image_are_inside_it()
    {
        var topLeft = new Tap(0, 0);
        var bottomRight = new Tap(1, 1);

        Assert.Equal(0, topLeft.X);
        Assert.Equal(1, bottomRight.Y);
        Assert.True(TapAnswer.TryParse("tap.v1:0,0;1,1", out var parsed));
        Assert.Equal([topLeft, bottomRight], parsed.Taps);
    }

    [Theory]
    [InlineData("tap.v1:1.5,0.5")]
    [InlineData("tap.v1:0.5,-0.2")]
    [InlineData("tap.v1:412,733")]       // pixels, the mistake this exists to catch
    [InlineData("tap.v1:NaN,0.5")]
    [InlineData("tap.v1:Infinity,0.5")]
    public void A_coordinate_outside_the_image_is_refused_on_the_way_in(string encoded)
    {
        Assert.False(TapAnswer.TryParse(encoded, out var answer));
        Assert.Null(answer);
    }

    [Fact]
    public void An_empty_tap_list_is_not_the_same_as_no_answer()
    {
        // a grid where nothing matches is answered by verify with nothing selected: an answer; an empty Value is silence
        Assert.False(TapAnswer.TryParse(string.Empty, out _));

        Assert.True(TapAnswer.TryParse(new TapAnswer { Submit = true }.Format(), out var verified));
        Assert.Empty(verified.Taps);
        Assert.True(verified.Submit);

        Assert.True(TapAnswer.TryParse(TapAnswer.Prefix, out var nothingYet));
        Assert.Empty(nothingYet.Taps);
        Assert.False(nothingYet.Submit);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("492013")]
    [InlineData("0.5,0.5")]                              // taps without the prefix are not taps
    [InlineData("appie://login-exit?code=abc123")]
    [InlineData("TAP.V1:0.5,0.5")]                       // ordinal, never case-insensitive
    [InlineData("tap.v2:0.5,0.5")]                       // a grammar we do not speak
    [InlineData("tap.v1:0.5")]
    [InlineData("tap.v1:0.5,0.5,0.5")]
    [InlineData("tap.v1:0.5,0.5;")]
    [InlineData("tap.v1:0.5;0.5")]
    [InlineData("tap.v1:0,5;0,5")]                       // a Dutch decimal comma, split as a pair
    public void Nothing_that_is_not_a_tap_answer_parses_as_one(string? value)
    {
        // the fallback that makes AnswerKind safe to ignore: a consumer showing a text box returns text, and text is refused
        Assert.False(TapAnswer.TryParse(value, out var answer));
        Assert.Null(answer);
    }

    [Fact]
    public void Submit_is_terminal()
    {
        // taps after the marker could never be delivered (the page moved on): refused as a producer disagreeing on the format
        Assert.False(TapAnswer.TryParse("tap.v1:submit;0.5,0.5", out _));
        Assert.False(TapAnswer.TryParse("tap.v1:0.5,0.5;submit;submit", out _));
        Assert.True(TapAnswer.TryParse("tap.v1:0.5,0.5;submit", out _));
    }

    [Fact]
    public void Surrounding_whitespace_is_forgiven_and_nothing_else_is()
    {
        // a trailing newline is untidy; an invented separator is wrong
        Assert.True(TapAnswer.TryParse("  tap.v1: 0.25,0.5 ; submit \n", out var answer));
        Assert.Equal([new Tap(0.25, 0.5)], answer.Taps);
        Assert.True(answer.Submit);
    }

    [Fact]
    public void Formatting_does_not_depend_on_the_machine_that_did_it()
    {
        // an agent in Amsterdam formats 0.5 as "0,5" and the comma is the pair separator: a tap in a different square
        var original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("nl-NL");

            Assert.Equal("tap.v1:0.25,0.5", new TapAnswer { Taps = [new Tap(0.25, 0.5)] }.Format());
            Assert.True(TapAnswer.TryParse("tap.v1:0.25,0.5", out var answer));
            Assert.Equal([new Tap(0.25, 0.5)], answer.Taps);
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public void A_coordinate_carries_only_the_precision_the_wire_holds()
    {
        // otherwise a tap would not equal the tap it was parsed from
        var tap = new Tap(0.123456789, 0.5);

        Assert.Equal(0.1235, tap.X);
        Assert.True(TapAnswer.TryParse(new TapAnswer { Taps = [tap] }.Format(), out var back));
        Assert.Equal([tap], back.Taps);
    }

    [Fact]
    public void A_tap_maps_back_into_the_region_the_picture_came_from()
    {
        // the crop's origin is part of the answer's meaning, and only the agent knows where the image was cut from
        var crop = new CropRegion(100, 200, 400, 300);

        var (x, y) = new Tap(0.5, 0.5).ToPagePixels(crop);
        Assert.Equal(300d, x, 6);
        Assert.Equal(350d, y, 6);

        var (left, top) = new Tap(0, 0).ToPagePixels(crop);
        Assert.Equal(100d, left, 6);
        Assert.Equal(200d, top, 6);

        var (right, bottom) = new Tap(1, 1).ToPagePixels(crop);
        Assert.Equal(500d, right, 6);
        Assert.Equal(500d, bottom, 6);
    }

    [Fact]
    public void The_same_fraction_survives_a_client_that_scaled_the_picture()
    {
        // normalised: the agent cropped 400x300 css px, the phone drew them 360 wide, and the tap still lands in the same tile
        var crop = new CropRegion(0, 0, 400, 300);
        const double DrawnWidth = 360d;
        const double DrawnHeight = 270d;

        var tap = new Tap(120d / DrawnWidth, 90d / DrawnHeight);

        var (x, y) = tap.ToPagePixels(crop);

        // within 0.1px on ~133px tiles; the wire's four decimals cost 0.04px, nowhere near a tile boundary
        Assert.Equal(400d / 3d, x, 1);
        Assert.Equal(100d, y, 1);
    }
}
