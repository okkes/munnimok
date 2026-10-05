using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http;
using Munni.Api.Auth;
using Xunit;

namespace Munni.Api.Tests;

/// <summary>
/// 2026-10-05: with the identity provider out of reach the api answered
/// every bearer with 401, and every app concluded its refresh token was
/// dead and logged the person out. A provider the api cannot ask is a
/// 503 that names itself; a token the provider rejected stays a 401.
/// </summary>
public class AuthOutageTests
{
    [Fact]
    public void A_provider_out_of_reach_is_told_apart_from_a_bad_token()
    {
        Assert.True(AuthOutage.IsProviderUnreachable(new HttpRequestException("Name does not resolve (logto)")));
        Assert.True(AuthOutage.IsProviderUnreachable(new InvalidOperationException("IDX20803: Unable to obtain configuration from: 'https://logto/oidc/.well-known/openid-configuration'.", new HttpRequestException("gateway"))));
        Assert.True(AuthOutage.IsProviderUnreachable(new InvalidOperationException("IDX20803: Unable to obtain configuration from: '[PII is hidden]'.")));
        Assert.True(AuthOutage.IsProviderUnreachable(new TaskCanceledException("the metadata request timed out")));
        Assert.False(AuthOutage.IsProviderUnreachable(new Microsoft.IdentityModel.Tokens.SecurityTokenExpiredException("IDX10223: Lifetime validation failed")));
        Assert.False(AuthOutage.IsProviderUnreachable(new Microsoft.IdentityModel.Tokens.SecurityTokenInvalidSignatureException("IDX10511")));
        Assert.False(AuthOutage.IsProviderUnreachable(null));
    }

    private static async Task<(int Status, string Body, bool Handled)> ChallengeAsync(Exception? failure)
    {
        var http = new DefaultHttpContext();
        http.Response.Body = new MemoryStream();
        var scheme = new AuthenticationScheme("Bearer", "Bearer", typeof(JwtBearerHandler));
        var context = new JwtBearerChallengeContext(http, scheme, new JwtBearerOptions(), new AuthenticationProperties()) { AuthenticateFailure = failure };
        await AuthOutage.Events().OnChallenge(context);
        http.Response.Body.Position = 0;
        var body = await new StreamReader(http.Response.Body, Encoding.UTF8).ReadToEndAsync();
        return (http.Response.StatusCode, body, context.Handled);
    }

    [Fact]
    public async Task An_unreachable_provider_answers_503_with_its_name_and_a_retry_after()
    {
        var (status, body, handled) = await ChallengeAsync(new HttpRequestException("Name does not resolve (logto)"));
        Assert.True(handled);
        Assert.Equal((int)HttpStatusCode.ServiceUnavailable, status);
        Assert.Equal(AuthOutage.ErrorCode, JsonNode.Parse(body)!["error"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_rejected_token_stays_the_handlers_401()
    {
        var (status, body, handled) = await ChallengeAsync(new Microsoft.IdentityModel.Tokens.SecurityTokenExpiredException("IDX10223"));
        Assert.False(handled);
        Assert.Equal(200, status);   // untouched: the handler writes its own 401 after this
        Assert.Equal(string.Empty, body);
    }
}
