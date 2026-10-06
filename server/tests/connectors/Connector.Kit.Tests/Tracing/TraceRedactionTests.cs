using Connector.Kit.Tracing;
using Xunit;

namespace Connector.Kit.Tests.Tracing;

/// <summary>
/// What a recording may never contain (#441 L3): the rules by name and by
/// value, pinned one by one, because a trace is the one artefact the
/// platform makes whose whole purpose is to be read by somebody else.
/// </summary>
public sealed class TraceRedactionTests
{
    [Fact]
    public void A_cookie_header_keeps_its_names_and_loses_every_value()
    {
        Assert.Equal("sid=«redacted:12»; lang=«redacted:2»", TraceRedaction.Header("Cookie", "sid=abcdefghijkl; lang=nl"));
        Assert.Equal("sid=«redacted:12»; Path=/; HttpOnly", TraceRedaction.Header("set-cookie", "sid=abcdefghijkl; Path=/; HttpOnly"));
    }

    [Fact]
    public void An_authorization_header_keeps_its_scheme_only()
    {
        Assert.Equal("Bearer «redacted:7»", TraceRedaction.Header("Authorization", "Bearer tok_123"));
        Assert.Equal("«redacted:5»", TraceRedaction.Header("X-Api-Key", "k-123"));
        Assert.Equal("«redacted:3»", TraceRedaction.Header("X-Session-Token", "abc"));
        Assert.Equal("application/json", TraceRedaction.Header("Content-Type", "application/json"));
        Assert.Equal("gzip", TraceRedaction.Header("Accept-Encoding", "gzip"));
    }

    [Fact]
    public void A_url_loses_its_user_info_and_its_secret_named_query_values()
    {
        Assert.Equal(
            "https://api.example.com/v1/orders?token=«redacted:6»&page=2#top",
            TraceRedaction.Url("https://user:pw@api.example.com/v1/orders?token=abcdef&page=2#top"));
        Assert.Equal("not a url", TraceRedaction.Url("not a url"));
    }

    [Fact]
    public void A_json_body_loses_its_secret_named_fields_and_keeps_the_rest()
    {
        var masked = TraceRedaction.Body("application/json",
            "{\"username\":\"shopper\",\"password\":\"hunter2\",\"nested\":{\"access_token\":\"t\",\"items\":[{\"pin\":\"1234\",\"id\":7}]}}");

        Assert.Contains("\"username\":\"shopper\"", masked, StringComparison.Ordinal);
        Assert.Contains("\"id\":7", masked, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", masked, StringComparison.Ordinal);
        Assert.DoesNotContain("1234", masked, StringComparison.Ordinal);
        Assert.Contains("\"password\":\"«redacted:7»\"", masked, StringComparison.Ordinal);
        Assert.Contains("\"access_token\":\"«redacted:1»\"", masked, StringComparison.Ordinal);
    }

    [Fact]
    public void A_body_that_is_nearly_json_still_loses_a_secret_pair_by_pattern()
    {
        var masked = TraceRedaction.Body("text/plain", "{\"password\":\"hunter2\",\"x\":");

        Assert.DoesNotContain("hunter2", masked, StringComparison.Ordinal);
        Assert.Contains("\"password\":\"«redacted:7»\"", masked, StringComparison.Ordinal);
    }

    [Fact]
    public void A_form_body_loses_its_secret_named_fields()
    {
        Assert.Equal("user=a&password=«redacted:3»&otp_code=«redacted:6»&remember=1",
            TraceRedaction.Body("application/x-www-form-urlencoded", "user=a&password=xyz&otp_code=123456&remember=1"));
    }

    [Fact]
    public void Every_secret_value_is_masked_wherever_it_appears_and_short_ones_are_left_alone()
    {
        var masked = TraceRedaction.Values("the page said hunter2 twice: hunter2; pin 12", ["hunter2", "12"]);

        Assert.Equal("the page said «redacted» twice: «redacted»; pin 12", masked);
    }

    [Fact]
    public void Text_types_are_read_and_assets_are_not()
    {
        Assert.True(TraceRedaction.IsText("application/json; charset=utf-8"));
        Assert.True(TraceRedaction.IsText("text/html"));
        Assert.True(TraceRedaction.IsText("application/problem+json"));
        Assert.True(TraceRedaction.IsText("application/x-www-form-urlencoded"));
        Assert.False(TraceRedaction.IsText("image/png"));
        Assert.False(TraceRedaction.IsText("application/pdf"));
        Assert.False(TraceRedaction.IsText(null));

        Assert.True(TraceRedaction.IsWorthReading("application/json"));
        Assert.False(TraceRedaction.IsWorthReading("text/css"));
        Assert.False(TraceRedaction.IsWorthReading("application/javascript"));
    }

    [Fact]
    public void A_fingerprint_is_a_length_and_twelve_hex_characters_never_the_value()
    {
        var (length, hash) = TraceRedaction.Fingerprint("secret-cookie-value");

        Assert.Equal(19, length);
        Assert.Equal(12, hash.Length);
        Assert.Matches("^[0-9a-f]{12}$", hash);
        Assert.NotEqual(hash, TraceRedaction.Fingerprint("secret-cookie-valuf").Hash);
    }
}
