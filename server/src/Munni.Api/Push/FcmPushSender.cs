using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Munni.Api.Social;

namespace Munni.Api.Push;

/// <summary>
/// Routes each subscription to its transport: browser rows (webpush) to
/// the VAPID sender, native shell rows (fcm) to Firebase. A kind whose
/// transport is not configured reports success so the row survives
/// until the transport arrives.
/// </summary>
public sealed class RoutingPushSender(IPushSender? webPush, IPushSender? fcm) : IPushSender
{
    public Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
    {
        var sender = subscription.Kind == "fcm" ? fcm : webPush;
        return sender is null ? Task.FromResult(true) : sender.SendAsync(subscription, payload, ct);
    }
}

/// <summary>
/// Visible notification text for native pushes, per device language —
/// the server-side twin of sw.ts/swNotifications (iOS displays NOTHING
/// for data-only messages while the app is closed, so unlike web push
/// the localization cannot happen on-device; user report: friend
/// requests never showed on iPhone).
/// </summary>
public static class FcmTexts
{
    private sealed record Texts(
        string One, string Many, string FriendRequest, string FriendAccept, string SpaceInvite, string SpaceJoin,
        string MemberRemoved, string MemberRole, IReadOnlyDictionary<string, string> Roles, string Someone, string ASpace, string Test);

    private static readonly Dictionary<string, Texts> All = new()
    {
        ["en"] = new("1 new transaction arrived", "{n} new transactions arrived", "{name} sent you a friend request", "{name} accepted your friend request", "{name} invited you to \"{space}\"", "{name} joined \"{space}\"",
            "You were removed from \"{space}\" by {name}", "Your role in \"{space}\" is now {role}",
            new Dictionary<string, string> { [SpaceRoles.Owner] = "owner", [SpaceRoles.Contributor] = "contributor", [SpaceRoles.Reader] = "reader" },
            "Someone", "a space", "Test notification — push reaches this device ✓"),
        ["nl"] = new("1 nieuwe transactie ontvangen", "{n} nieuwe transacties ontvangen", "{name} heeft je een vriendschapsverzoek gestuurd", "{name} heeft je vriendschapsverzoek geaccepteerd", "{name} heeft je uitgenodigd voor \"{space}\"", "{name} doet nu mee in \"{space}\"",
            "{name} heeft je verwijderd uit \"{space}\"", "Je rol in \"{space}\" is nu {role}",
            new Dictionary<string, string> { [SpaceRoles.Owner] = "eigenaar", [SpaceRoles.Contributor] = "bijdrager", [SpaceRoles.Reader] = "lezer" },
            "Iemand", "een ruimte", "Testmelding — push bereikt dit apparaat ✓"),
        ["tr"] = new("1 yeni işlem geldi", "{n} yeni işlem geldi", "{name} sana arkadaşlık isteği gönderdi", "{name} arkadaşlık isteğini kabul etti", "{name} seni \"{space}\" alanına davet etti", "{name} \"{space}\" alanına katıldı",
            "{name} seni \"{space}\" alanından çıkardı", "\"{space}\" alanındaki rolün artık {role}",
            new Dictionary<string, string> { [SpaceRoles.Owner] = "sahip", [SpaceRoles.Contributor] = "katkıda bulunan", [SpaceRoles.Reader] = "okuyucu" },
            "Birisi", "bir alan", "Test bildirimi — anlık bildirim bu cihaza ulaşıyor ✓"),
    };

    private const string SettledGet = "settled-get";
    private const string SettledPay = "settled-pay";
    private const string SettledEven = "settled-even";

    /// <summary>#538: what happens in a split event, by kind; `settled` is worded by the receiver's own figure</summary>
    private static readonly Dictionary<string, Dictionary<string, string>> Split = new()
    {
        ["en"] = new()
        {
            ["invited"] = "{name} invited you to the split event \"{split}\"",
            ["join-request"] = "{name} asks to join \"{split}\"",
            ["approved"] = "You are in: \"{split}\"",
            ["refused"] = "Your request to join \"{split}\" was turned down",
            ["invite-accepted"] = "{name} joined \"{split}\"",
            ["invite-declined"] = "{name} declined the invitation to \"{split}\"",
            [SettledGet] = "\"{split}\" is settled: you get {amount}",
            [SettledPay] = "\"{split}\" is settled: you pay {amount}",
            [SettledEven] = "\"{split}\" is settled: you are even",
            ["payment-paid"] = "{name} marked a payment of {amount} as paid in \"{split}\"",
            ["delete-planned"] = "{name} is deleting \"{split}\" — it is gone in 7 days unless an owner stops it",
            ["delete-stopped"] = "\"{split}\" stays: its deletion was stopped",
            ["removed"] = "{name} took you out of \"{split}\"",
            ["made-owner"] = "{name} made you an owner of \"{split}\"",
        },
        ["nl"] = new()
        {
            ["invited"] = "{name} heeft je uitgenodigd voor het splitevenement \"{split}\"",
            ["join-request"] = "{name} wil meedoen met \"{split}\"",
            ["approved"] = "Je doet mee: \"{split}\"",
            ["refused"] = "Je verzoek om mee te doen met \"{split}\" is afgewezen",
            ["invite-accepted"] = "{name} doet mee met \"{split}\"",
            ["invite-declined"] = "{name} heeft de uitnodiging voor \"{split}\" afgeslagen",
            [SettledGet] = "\"{split}\" is afgerekend: je krijgt {amount}",
            [SettledPay] = "\"{split}\" is afgerekend: je betaalt {amount}",
            [SettledEven] = "\"{split}\" is afgerekend: je staat quitte",
            ["payment-paid"] = "{name} heeft een betaling van {amount} in \"{split}\" als betaald gemarkeerd",
            ["delete-planned"] = "{name} verwijdert \"{split}\" — over 7 dagen is het weg, tenzij een eigenaar het stopt",
            ["delete-stopped"] = "\"{split}\" blijft: het verwijderen is gestopt",
            ["removed"] = "{name} heeft je uit \"{split}\" gehaald",
            ["made-owner"] = "{name} heeft je eigenaar gemaakt van \"{split}\"",
        },
        ["tr"] = new()
        {
            ["invited"] = "{name} seni \"{split}\" bölüşme etkinliğine davet etti",
            ["join-request"] = "{name} \"{split}\" etkinliğine katılmak istiyor",
            ["approved"] = "Katıldın: \"{split}\"",
            ["refused"] = "\"{split}\" etkinliğine katılma isteğin reddedildi",
            ["invite-accepted"] = "{name} \"{split}\" etkinliğine katıldı",
            ["invite-declined"] = "{name} \"{split}\" davetini reddetti",
            [SettledGet] = "\"{split}\" hesaplaşıldı: {amount} alacaksın",
            [SettledPay] = "\"{split}\" hesaplaşıldı: {amount} ödeyeceksin",
            [SettledEven] = "\"{split}\" hesaplaşıldı: borcun da alacağın da yok",
            ["payment-paid"] = "{name} \"{split}\" içindeki {amount} tutarındaki ödemeyi ödendi olarak işaretledi",
            ["delete-planned"] = "{name} \"{split}\" etkinliğini siliyor — bir sahip durdurmazsa 7 gün sonra silinir",
            ["delete-stopped"] = "\"{split}\" kalıyor: silme işlemi durduruldu",
            ["removed"] = "{name} seni \"{split}\" etkinliğinden çıkardı",
            ["made-owner"] = "{name} seni \"{split}\" etkinliğinin sahibi yaptı",
        },
    };

    /// <summary>The sentence for a split event's notice, or null for a kind this build does not word.</summary>
    private static string? SplitBody(JsonElement payload, string lang, string someone)
    {
        string Str(string name, string fallback) =>
            payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
        var cents = payload.TryGetProperty("cents", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt64() : 0;
        var kind = Str("kind", "");
        if (kind == "settled") kind = cents switch { > 0 => SettledGet, < 0 => SettledPay, _ => SettledEven };
        var texts = Split.GetValueOrDefault(lang) ?? Split["en"];
        if (!texts.TryGetValue(kind, out var template)) return null;
        var amount = $"{(Math.Abs(cents) / 100m).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)} {Str("currency", "")}".Trim();
        return template.Replace("{name}", Str("fromName", someone)).Replace("{split}", Str("splitName", "")).Replace("{amount}", amount);
    }

    /// <summary>title+body for a payload, or null for types with no visible text</summary>
    public static (string Title, string Body)? Build(JsonElement payload, string lang)
    {
        var texts = All.GetValueOrDefault(lang) ?? All["en"];
        var type = payload.TryGetProperty("type", out var t) ? t.GetString() : null;
        string Str(string name, string fallback) =>
            payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
        string Social(string template) =>
            template.Replace("{name}", Str("fromName", texts.Someone)).Replace("{space}", Str("spaceName", texts.ASpace));
        string Role() => texts.Roles.GetValueOrDefault(Str("role", "")) ?? Str("role", "");

        var body = type switch
        {
            "new-transactions" when payload.TryGetProperty("count", out var c) && c.TryGetInt32(out var n) && n != 1 =>
                texts.Many.Replace("{n}", n.ToString()),
            "new-transactions" => texts.One,
            "friend-request" => Social(texts.FriendRequest),
            "friend-accept" => Social(texts.FriendAccept),
            "space-invite" => Social(texts.SpaceInvite),
            "space-join" => Social(texts.SpaceJoin),
            "member-removed" => Social(texts.MemberRemoved),
            "member-role" => Social(texts.MemberRole).Replace("{role}", Role()),
            "split" => SplitBody(payload, lang, texts.Someone),
            "test" => texts.Test,
            _ => null,
        };
        if (body is null) return null;
        // #551: a notification about one space wears its name as the title — the lock screen already says
        // "munni" above it; the social ones name their space in the sentence
        var spaceName = Str("spaceName", "").Trim();
        var title = (type is "new-transactions" or "test") && spaceName.Length > 0 ? spaceName : "munni";
        return (title, body);
    }
}

/// <summary>
/// FCM HTTP v1 (native-apps design N4): a service-account JWT buys a
/// short-lived OAuth token. Messages carry the data payload for in-app
/// handling PLUS a notification block localized per device (FcmTexts) —
/// without it, closed iOS apps never display anything.
/// Configured via Fcm:ServiceAccountJson (the downloaded key file).
/// </summary>
public sealed class FcmPushSender : IPushSender
{
    // omit the notification field entirely when a payload type has no
    // visible text — FCM treats an explicit null as a malformed message
    private static readonly JsonSerializerOptions JsonOptions = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    private readonly HttpClient _http;
    private readonly string _projectId;
    private readonly string _clientEmail;
    private readonly RSA _key;
    private string? _accessToken;
    private DateTimeOffset _accessTokenExpiry = DateTimeOffset.MinValue;

    public FcmPushSender(HttpClient http, IConfiguration config)
    {
        _http = http;
        using var account = JsonDocument.Parse(config["Fcm:ServiceAccountJson"]!);
        _projectId = account.RootElement.GetProperty("project_id").GetString()!;
        _clientEmail = account.RootElement.GetProperty("client_email").GetString()!;
        _key = RSA.Create();
        _key.ImportFromPem(account.RootElement.GetProperty("private_key").GetString()!);
    }

    public async Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
    {
        var token = await GetAccessTokenAsync(ct);
        using var doc = JsonDocument.Parse(payload);
        var visible = FcmTexts.Build(doc.RootElement, subscription.Lang);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"v1/projects/{_projectId}/messages:send");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            message = new
            {
                token = subscription.Endpoint,
                // data for the in-app handlers (routing, refresh) …
                data = new { payload },
                // … and the OS-rendered notification: closed iOS apps show
                // nothing for data-only messages (user report)
                notification = visible is null ? null : new { title = visible.Value.Title, body = visible.Value.Body },
                android = new { priority = "high" },
                apns = new { headers = new Dictionary<string, string> { ["apns-priority"] = "10" }, payload = new { aps = new { sound = "default" } } },
            },
        }, JsonOptions), Encoding.UTF8, "application/json");

        using var response = await _http.SendAsync(request, ct);
        if (response.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Gone)
            return false; // UNREGISTERED — the caller removes the row
        if (!response.IsSuccessStatusCode)
        {
            // relay FCM's own reason (self-diagnosing rule): a bare status
            // hid "SENDER_ID_MISMATCH"-class config errors for days
            var body = await response.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException(
                $"{(int)response.StatusCode} {response.StatusCode} from FCM: {(body.Length > 300 ? body[..300] : body)}",
                null, response.StatusCode);
        }
        return true;
    }

    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        if (_accessToken is not null && DateTimeOffset.UtcNow < _accessTokenExpiry) return _accessToken;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var claims = JsonSerializer.Serialize(new
        {
            iss = _clientEmail,
            scope = "https://www.googleapis.com/auth/firebase.messaging",
            aud = "https://oauth2.googleapis.com/token",
            iat = now,
            exp = now + 3600,
        });
        var jwt = SignJwt(claims);

        using var response = await _http.PostAsync("https://oauth2.googleapis.com/token", new FormUrlEncodedContent(new Dictionary<string, string> // NOSONAR(S1075) vendor token endpoint
        {
            ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ["assertion"] = jwt,
        }), ct);
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        _accessToken = body.RootElement.GetProperty("access_token").GetString()!;
        var expiresIn = body.RootElement.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;
        _accessTokenExpiry = DateTimeOffset.UtcNow.AddSeconds(expiresIn - 300);
        return _accessToken;
    }

    private string SignJwt(string claimsJson)
    {
        static string B64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var header = B64Url(Encoding.UTF8.GetBytes("""{"alg":"RS256","typ":"JWT"}"""));
        var body = B64Url(Encoding.UTF8.GetBytes(claimsJson));
        var signature = _key.SignData(Encoding.UTF8.GetBytes($"{header}.{body}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{body}.{B64Url(signature)}";
    }
}
