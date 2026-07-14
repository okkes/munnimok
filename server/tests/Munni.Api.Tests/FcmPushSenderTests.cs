using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Munni.Api.Push;

namespace Munni.Api.Tests;

/// <summary>
/// The FCM HTTP v1 client against a scripted handler: service-account
/// JWT exchange, token caching, message shape, unregistered pruning.
/// </summary>
public class FcmPushSenderTests
{
    private sealed class ScriptedHandler : HttpMessageHandler
    {
        public int TokenCalls;
        public string? LastSendBody;
        public HttpStatusCode SendStatus = HttpStatusCode.OK;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.Host == "oauth2.googleapis.com")
            {
                TokenCalls++;
                var form = await request.Content!.ReadAsStringAsync(ct);
                Assert.Contains("jwt-bearer", form);
                // the assertion is a three-part signed JWT
                var assertion = System.Web.HttpUtility.ParseQueryString(form)["assertion"]!;
                Assert.Equal(3, assertion.Split('.').Length);
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""{"access_token":"ya29.test","expires_in":3600}""", Encoding.UTF8, "application/json"),
                };
            }

            Assert.Equal("/v1/projects/munni-test/messages:send", request.RequestUri.AbsolutePath);
            Assert.Equal("ya29.test", request.Headers.Authorization?.Parameter);
            LastSendBody = await request.Content!.ReadAsStringAsync(ct);
            return new HttpResponseMessage(SendStatus)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        }
    }

    private static (FcmPushSender sender, ScriptedHandler handler) Create()
    {
        using var rsa = RSA.Create(2048);
        var serviceAccount = JsonSerializer.Serialize(new
        {
            project_id = "munni-test",
            client_email = "push@munni-test.iam.gserviceaccount.com",
            private_key = rsa.ExportPkcs8PrivateKeyPem(),
        });
        var handler = new ScriptedHandler();
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://fcm.googleapis.com/") };
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Fcm:ServiceAccountJson"] = serviceAccount })
            .Build();
        return (new FcmPushSender(http, config), handler);
    }

    private static PushSubscriptionRow Row(string token) => new()
    {
        Id = Guid.NewGuid(),
        UserId = Guid.NewGuid(),
        Kind = "fcm",
        Endpoint = token,
    };

    [Fact]
    public async Task Sends_data_only_messages_and_reuses_the_oauth_token()
    {
        var (sender, handler) = Create();
        Assert.True(await sender.SendAsync(Row("tok-1"), """{"type":"new-transactions"}""", CancellationToken.None));
        Assert.True(await sender.SendAsync(Row("tok-2"), """{"type":"friend-request"}""", CancellationToken.None));

        Assert.Equal(1, handler.TokenCalls); // cached until expiry
        Assert.Contains("\"token\":\"tok-2\"", handler.LastSendBody);
        Assert.Contains("friend-request", handler.LastSendBody);
        Assert.Contains("\"data\":", handler.LastSendBody); // data-only: the app localizes
    }

    [Fact]
    public async Task An_unregistered_token_reports_false_so_the_row_is_pruned()
    {
        var (sender, handler) = Create();
        handler.SendStatus = HttpStatusCode.NotFound; // FCM: UNREGISTERED
        Assert.False(await sender.SendAsync(Row("tok-gone"), "{}", CancellationToken.None));
    }
}
