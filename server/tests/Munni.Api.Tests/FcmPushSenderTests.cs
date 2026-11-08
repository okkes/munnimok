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

    private static PushSubscriptionRow Row(string token, string lang = "en") => new()
    {
        Id = Guid.NewGuid(),
        UserId = Guid.NewGuid(),
        Kind = "fcm",
        Endpoint = token,
        Lang = lang,
    };

    [Fact]
    public async Task Sends_data_plus_visible_notification_and_reuses_the_oauth_token()
    {
        var (sender, handler) = Create();
        Assert.True(await sender.SendAsync(Row("tok-1"), """{"type":"new-transactions","count":3}""", CancellationToken.None));
        Assert.Contains("3 new transactions arrived", handler.LastSendBody);
        Assert.True(await sender.SendAsync(Row("tok-2"), """{"type":"friend-request","fromName":"Ayse"}""", CancellationToken.None));

        Assert.Equal(1, handler.TokenCalls); // cached until expiry
        Assert.Contains("\"token\":\"tok-2\"", handler.LastSendBody);
        Assert.Contains("\"data\":", handler.LastSendBody); // in-app routing payload rides along
        // the OS-rendered notification block: closed iOS apps show nothing
        // for data-only messages (user report: friend requests never showed)
        Assert.Contains("\"notification\":", handler.LastSendBody);
        Assert.Contains("sent you a friend request", handler.LastSendBody);
        Assert.Contains("apns-priority", handler.LastSendBody);
    }

    [Fact]
    public async Task Notification_text_follows_the_device_language()
    {
        var (sender, handler) = Create();
        Assert.True(await sender.SendAsync(Row("tok-nl", "nl"), """{"type":"friend-request","fromName":"Bob"}""", CancellationToken.None));
        Assert.Contains("Bob heeft je een vriendschapsverzoek gestuurd", handler.LastSendBody);

        Assert.True(await sender.SendAsync(Row("tok-tr", "tr"), """{"type":"space-invite","fromName":"Bob","spaceName":"Ev"}""", CancellationToken.None));
        Assert.Contains("alan", handler.LastSendBody); // "… \"Ev\" alanına davet etti"

        // unknown types stay data-only (no notification block)
        Assert.True(await sender.SendAsync(Row("tok-x"), """{"type":"mystery"}""", CancellationToken.None));
        Assert.DoesNotContain("\"notification\":", handler.LastSendBody);
    }

    private static (string Title, string Body) Text(string payload, string lang = "en") =>
        FcmTexts.Build(JsonDocument.Parse(payload).RootElement, lang)!.Value;

    [Fact]
    public void A_notification_about_one_space_is_titled_with_its_name()
    {
        // #551: the lock screen says which space the transactions landed in
        Assert.Equal(("Household", "2 new transactions arrived"), Text("""{"type":"new-transactions","spaceId":"s1","spaceName":"Household","count":2}"""));
        Assert.Equal("Trip", Text("""{"type":"test","spaceId":"s2","spaceName":"Trip"}""").Title);
        // no readable name: the app's own
        Assert.Equal("munni", Text("""{"type":"new-transactions","spaceId":"s1","spaceName":null,"count":1}""").Title);
        // a social one names its space in the sentence instead
        Assert.Equal(("munni", "Bob joined \"Household\""), Text("""{"type":"space-join","fromName":"Bob","spaceId":"s1","spaceName":"Household"}"""));
    }

    [Fact]
    public void Membership_changes_reach_the_phone_with_their_own_text_in_every_language()
    {
        // these were data-only before — a closed iPhone showed nothing at all
        Assert.Equal("You were removed from \"Huis\" by Alice", Text("""{"type":"member-removed","fromName":"Alice","spaceName":"Huis"}""").Body);
        Assert.Equal("Je rol in \"Huis\" is nu lezer", Text("""{"type":"member-role","spaceName":"Huis","role":"reader"}""", "nl").Body);
        Assert.Contains("okuyucu", Text("""{"type":"member-role","spaceName":"Ev","role":"reader"}""", "tr").Body);
        // a role this build does not know passes through as it came
        Assert.Equal("Your role in \"Huis\" is now wizard", Text("""{"type":"member-role","spaceName":"Huis","role":"wizard"}""").Body);
    }

    [Fact]
    public async Task An_unregistered_token_reports_false_so_the_row_is_pruned()
    {
        var (sender, handler) = Create();
        handler.SendStatus = HttpStatusCode.NotFound; // FCM: UNREGISTERED
        Assert.False(await sender.SendAsync(Row("tok-gone"), "{}", CancellationToken.None));
    }
}
