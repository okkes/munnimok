using System.Security.Claims;
using System.Security.Cryptography;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Auth;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Connector.Api.Tests;

/// <summary>
/// Production authentication against the real bearer handler, with a signing
/// key of our own standing in for the identity provider: a token from the
/// wrong issuer, for another audience or under another key is no caller; a
/// valid one is; the required scope is required; and the admin routes want
/// the admin scope on top, answering a known caller 403 rather than 401.
/// </summary>
public sealed class ProductionAuthTests
{
    private const string Issuer = "https://issuer.test";
    private const string Audience = "connector.munni";

    private static readonly SymmetricSecurityKey Key = new(RandomNumberGenerator.GetBytes(32)) { KeyId = "k1" };

    [Fact]
    public async Task No_token_or_a_token_minted_for_somebody_else_is_no_caller()
    {
        await using var services = Host();
        var auth = services.GetRequiredService<ConnectorAuth>();

        Assert.False(await auth.AuthenticateAsync(Call(services, null)));
        Assert.False(await auth.AuthenticateAsync(Call(services, "not-a-token")));
        Assert.False(await auth.AuthenticateAsync(Call(services, Token(issuer: "https://elsewhere.test"))));
        Assert.False(await auth.AuthenticateAsync(Call(services, Token(audience: "some-other-api"))));
        Assert.False(await auth.AuthenticateAsync(Call(services, Token(key: new SymmetricSecurityKey(RandomNumberGenerator.GetBytes(32))))));
    }

    [Fact]
    public async Task A_token_minted_for_this_service_is_a_caller_whose_claims_travel_with_the_request()
    {
        await using var services = Host();
        var auth = services.GetRequiredService<ConnectorAuth>();
        var http = Call(services, Token("connector:consume"));

        Assert.True(await auth.AuthenticateAsync(http));
        Assert.Equal("munni-api", http.User.FindFirst("sub")?.Value);
        Assert.True(ConnectorAuth.HasScope(http.User, "connector:consume"));
    }

    [Fact]
    public async Task The_required_scope_is_required()
    {
        await using var services = Host(requiredScope: "connector:consume");
        var auth = services.GetRequiredService<ConnectorAuth>();

        Assert.False(await auth.AuthenticateAsync(Call(services, Token())));
        Assert.False(await auth.AuthenticateAsync(Call(services, Token("connector:admin"))));

        Assert.True(await auth.AuthenticateAsync(Call(services, Token("connector:admin connector:consume"))));
    }

    [Fact]
    public async Task The_admin_routes_want_the_admin_scope_and_answer_a_known_caller_403_without_it()
    {
        await using var services = Host();
        var auth = services.GetRequiredService<ConnectorAuth>();
        var filter = services.GetRequiredService<AdminScopeFilter>();

        var consumer = Call(services, Token("connector:consume"));
        Assert.True(await auth.AuthenticateAsync(consumer));
        var refused = await filter.InvokeAsync(new DefaultEndpointFilterInvocationContext(consumer), Reached);
        Assert.Equal(StatusCodes.Status403Forbidden, Assert.IsType<IStatusCodeHttpResult>(refused, exactMatch: false).StatusCode);

        var operatorCall = Call(services, Token("connector:consume connector:admin"));
        Assert.True(await auth.AuthenticateAsync(operatorCall));
        Assert.Equal("reached", await filter.InvokeAsync(new DefaultEndpointFilterInvocationContext(operatorCall), Reached));
    }

    [Fact]
    public async Task Development_has_no_tokens_so_the_shared_secret_admits_an_operator_too()
    {
        await using var services = Host(mode: ConnectorMode.Development);
        var filter = services.GetRequiredService<AdminScopeFilter>();

        Assert.Equal("reached", await filter.InvokeAsync(new DefaultEndpointFilterInvocationContext(Call(services, null)), Reached));
    }

    [Fact]
    public void Scopes_are_read_from_one_space_separated_claim_or_from_several()
    {
        var one = new ClaimsPrincipal(new ClaimsIdentity([new Claim("scope", "a connector:admin b")]));
        var several = new ClaimsPrincipal(new ClaimsIdentity([new Claim("scope", "a"), new Claim("scope", "connector:admin")]));

        Assert.True(ConnectorAuth.HasScope(one, "connector:admin"));
        Assert.True(ConnectorAuth.HasScope(several, "connector:admin"));
        Assert.False(ConnectorAuth.HasScope(one, "connector"));
        Assert.False(ConnectorAuth.HasScope(one, "connector:admin b"));
        Assert.False(ConnectorAuth.HasScope(null, "connector:admin"));
    }

    private static ValueTask<object?> Reached(EndpointFilterInvocationContext _) => ValueTask.FromResult<object?>("reached");

    private static ServiceProvider Host(string? requiredScope = null, ConnectorMode mode = ConnectorMode.Production)
    {
        var options = new ConnectorOptions { Mode = mode };
        options.Auth.Authority = Issuer;
        options.Auth.Audience = Audience;
        options.Auth.RequiredScope = requiredScope;

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(Options.Create(options));
        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(jwt =>
        {
            jwt.MapInboundClaims = false;
            jwt.TokenValidationParameters = new TokenValidationParameters
            {
                ValidIssuer = Issuer,
                ValidAudience = Audience,
                IssuerSigningKey = Key,
            };
        });
        services.AddSingleton<ConnectorAuth>();
        services.AddSingleton<AdminScopeFilter>();

        return services.BuildServiceProvider();
    }

    private static string Token(string? scope = null, string issuer = Issuer, string audience = Audience, SecurityKey? key = null)
    {
        var claims = new Dictionary<string, object>(StringComparer.Ordinal) { ["sub"] = "munni-api" };
        if (scope is not null) claims["scope"] = scope;

        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            Claims = claims,
            NotBefore = DateTime.UtcNow.AddMinutes(-1),
            Expires = DateTime.UtcNow.AddMinutes(5),
            SigningCredentials = new SigningCredentials(key ?? Key, SecurityAlgorithms.HmacSha256),
        });
    }

    /// <summary>
    /// One request: its own service scope, because the authentication
    /// handler cache is per scope and a handler stays bound to the first
    /// context it was initialised for.
    /// </summary>
    private static DefaultHttpContext Call(IServiceProvider services, string? token)
    {
        var http = new DefaultHttpContext { RequestServices = services.CreateScope().ServiceProvider };
        if (token is not null) http.Request.Headers.Authorization = "Bearer " + token;
        return http;
    }
}
