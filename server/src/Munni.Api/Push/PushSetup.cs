using Munni.Api.Data;

namespace Munni.Api.Push;

/// <summary>
/// Push transport registration, each enabled by its own config: VAPID
/// keys for the browsers, a Firebase service account for the native
/// shells (native-apps design N4). The routing sender delivers every
/// subscription through whichever transport its kind has.
/// </summary>
public static class PushSetup
{
    /// <returns>whether web push is configured (the /health capability flag)</returns>
    public static bool Register(IServiceCollection services, IConfiguration config)
    {
        var webPushEnabled = !string.IsNullOrEmpty(config["Push:VapidPublicKey"])
                             && !string.IsNullOrEmpty(config["Push:VapidPrivateKey"]);
        var fcmEnabled = !string.IsNullOrEmpty(config["Fcm:ServiceAccountJson"]);

        if (fcmEnabled)
            services.AddHttpClient("fcm", client => client.BaseAddress = new Uri("https://fcm.googleapis.com/")); // NOSONAR(S1075) vendor API base
        if (webPushEnabled || fcmEnabled)
        {
            services.AddSingleton<IPushSender>(sp => new RoutingPushSender(
                webPushEnabled ? new WebPushSender(sp.GetRequiredService<IConfiguration>()) : null,
                fcmEnabled
                    ? new FcmPushSender(sp.GetRequiredService<IHttpClientFactory>().CreateClient("fcm"), sp.GetRequiredService<IConfiguration>())
                    : null));
        }
        services.AddScoped(sp => new PushNotifier(
            sp.GetRequiredService<AppDbContext>(),
            sp.GetService<IPushSender>() ?? new NoopPushSender(),
            sp.GetRequiredService<ILogger<PushNotifier>>()));
        return webPushEnabled;
    }
}
