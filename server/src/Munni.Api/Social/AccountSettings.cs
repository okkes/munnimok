using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Social;

/// <summary>One setting as a device chose it: its value (null = back to the default) and the moment of the choice.</summary>
public sealed record SettingEntry(string? Value, DateTimeOffset At);

public sealed record AccountSettingsRequest(Dictionary<string, SettingEntry>? Settings);

/// <summary>#700: the settings a person carries from device to device (language, appearance, how receipts are read …) —
/// a small map kept on the user. The API does not know the settings: a device names them, and of two choices of one
/// setting the newest wins.</summary>
public static class AccountSettings
{
    public const int MaxKeys = 40;
    public const int MaxValueLength = 200;

    private static readonly Regex Name = new("^[a-z][A-Za-z0-9]{0,39}$", RegexOptions.None, TimeSpan.FromMilliseconds(100));
    private static readonly JsonSerializerOptions Stored = new(JsonSerializerDefaults.Web);

    public static bool Valid(IReadOnlyDictionary<string, SettingEntry> asked) =>
        asked.Count is > 0 and <= MaxKeys && asked.All(pair => Name.IsMatch(pair.Key) && pair.Value is not null && (pair.Value.Value?.Length ?? 0) <= MaxValueLength);

    public static Dictionary<string, SettingEntry> Read(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return [];
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, SettingEntry>>(stored, Stored) ?? [];
        }
        catch (JsonException)
        {
            // an unreadable map is an empty one: the next choice writes a good one
            return [];
        }
    }

    /// <summary>each setting only moves forward, and never past the server's clock — a device running ahead would
    /// otherwise outvote every later choice; null when nothing moved</summary>
    public static string? Merged(string? stored, IReadOnlyDictionary<string, SettingEntry> asked, DateTimeOffset now)
    {
        var map = Read(stored);
        var moved = false;
        foreach (var (key, entry) in asked)
        {
            var at = entry.At.ToUniversalTime();
            if (at > now) at = now;
            var known = map.TryGetValue(key, out var held);
            if (known ? held!.At >= at : map.Count >= MaxKeys) continue;
            map[key] = new SettingEntry(entry.Value, at);
            moved = true;
        }
        return moved ? JsonSerializer.Serialize(map, Stored) : null;
    }
}

public static class AccountSettingsEndpoints
{
    public static void MapAccountSettings(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/me/settings").RequireAuthorization();

        group.MapGet("", async (AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var me = http.GetUserId();
            var stored = await db.Users.Where(u => u.Id == me).Select(u => u.Settings).FirstOrDefaultAsync(ct);
            return Results.Ok(new { settings = AccountSettings.Read(stored) });
        });

        group.MapPut("", async (AccountSettingsRequest request, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            if (request.Settings is null || !AccountSettings.Valid(request.Settings)) return Results.BadRequest(new { error = "settings" });
            var user = await db.Users.FindAsync([http.GetUserId()], ct);
            if (user is null) return Results.NotFound();
            // two devices saving in the same instant can drop one of the two choices: the device that finds its own
            // choice missing on its next read sends it again
            var merged = AccountSettings.Merged(user.Settings, request.Settings, DateTimeOffset.UtcNow);
            if (merged is not null)
            {
                user.Settings = merged;
                await db.SaveChangesAsync(ct);
            }
            return Results.Ok(new { settings = AccountSettings.Read(user.Settings) });
        });
    }
}
