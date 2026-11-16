using Connector.Kit.Challenges;
using Xunit;

namespace Connector.Kit.Tests.Challenges;

// a streamed login shows no address bar or padlock: this string is the only evidence of whose password box it is,
// so every case is a security case
public sealed class LiveOriginTests
{
    [Theory]
    [InlineData("https://login.ah.nl/login?client_id=x&code=secret", "https://login.ah.nl")]
    [InlineData("https://login.ah.nl:8443/login", "https://login.ah.nl:8443")]
    [InlineData("http://localhost:8420/", "http://localhost:8420")]
    [InlineData("https://LOGIN.AH.NL/Login", "https://login.ah.nl")]
    public void An_origin_is_the_origin_and_never_the_rest_of_the_url(string url, string expected) =>
        Assert.Equal(expected, LiveOrigin.Normalize(url));

    // a login puts its authorization code in the query and this value is rendered and relayed: origin only
    [Fact]
    public void A_secret_in_the_query_string_never_reaches_the_screen()
    {
        var origin = LiveOrigin.Normalize("https://login.ah.nl/cb?code=abc123&state=xyz");

        Assert.Equal("https://login.ah.nl", origin);
        Assert.DoesNotContain("abc123", origin, StringComparison.Ordinal);
    }

    // "аh.nl" starts with a Cyrillic а (U+0430), indistinguishable from "ah.nl" when rendered;
    // browsers show punycode for this reason
    [Fact]
    public void A_lookalike_domain_is_shown_as_punycode_rather_than_as_the_real_thing()
    {
        var origin = LiveOrigin.Normalize("https://аh.nl/login");

        Assert.Equal("https://xn--h-7sb.nl", origin);

        // the assertion that carries the security property, independent of the exact encoding above
        Assert.NotEqual("https://ah.nl", origin);
        Assert.StartsWith("https://xn--", origin, StringComparison.Ordinal);
    }

    // not somebody's sign-in page: showing one where a domain belongs would dress up "unknown" as an answer
    [Theory]
    [InlineData("about:blank")]
    [InlineData("data:text/html,<h1>Sign in</h1>")]
    [InlineData("file:///tmp/login.html")]
    [InlineData("javascript:alert(1)")]
    [InlineData("chrome://newtab")]
    public void A_scheme_that_is_not_a_website_has_no_origin_to_show(string url) =>
        Assert.Null(LiveOrigin.Normalize(url));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not a url")]
    [InlineData("/login")]
    public void Anything_unparseable_reads_as_unknown_rather_than_as_itself(string? url) =>
        Assert.Null(LiveOrigin.Normalize(url));

    // DNS caps a host at 253 characters: past that it is not a hostname and the origin is refused
    [Fact]
    public void An_absurdly_long_host_is_refused_rather_than_truncated()
    {
        var url = "https://" + new string('a', LiveOrigin.MaxLength) + ".nl";

        Assert.Null(LiveOrigin.Normalize(url));
    }

    // the length cap was once applied to the whole URL before parsing, so any page behind an OAuth authorize call
    // lost its origin (Lidl's exceeds 300 characters) and showed a password box with no name
    [Fact]
    public void A_long_query_string_does_not_cost_the_page_its_name()
    {
        var url =
            "https://accounts.lidl.com/connect/authorize"
            + "?client_id=LidlPlusNativeClient"
            + "&response_type=code"
            + "&redirect_uri=com.lidlplus.app%3A%2F%2Fcallback"
            + "&scope=openid%20profile%20offline_access%20lpprofile%20lpapis"
            + "&code_challenge=" + new string('a', 43)
            + "&code_challenge_method=S256"
            + "&nonce=" + new string('b', 32)
            + "&state=" + new string('c', 32)
            + "&Country=NL&language=nl-NL";

        Assert.True(url.Length > LiveOrigin.MaxLength, "the URL under test has to be a long one");

        Assert.Equal("https://accounts.lidl.com", LiveOrigin.Normalize(url));
    }

    [Fact]
    public void A_url_far_past_any_real_one_is_still_refused_before_parsing()
    {
        var url = "https://example.test/?q=" + new string('a', LiveOrigin.MaxUrlLength);

        Assert.Null(LiveOrigin.Normalize(url));
    }
}
