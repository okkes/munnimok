using System.Net;
using System.Net.Http.Json;
using Munni.Api.Social;
using Xunit;

namespace Munni.Api.Tests;

/// <summary>#700: the settings a person carries from device to device.</summary>
public class AccountSettingsTests : IClassFixture<SyncApiFactory>
{
    private readonly SyncApiFactory _factory;

    public AccountSettingsTests(SyncApiFactory factory) => _factory = factory;

    private sealed record Held(Dictionary<string, SettingEntry> Settings);

    private HttpClient ClientFor(string sub, string device = "test-device")
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", device);
        return client;
    }

    private static AccountSettingsRequest Asking(params (string Key, string? Value, DateTimeOffset At)[] entries) =>
        new(entries.ToDictionary(entry => entry.Key, entry => new SettingEntry(entry.Value, entry.At)));

    private static async Task<Dictionary<string, SettingEntry>> ReadAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<Held>("/me/settings"))!.Settings;

    [Fact]
    public async Task A_setting_chosen_on_one_device_is_what_the_other_reads_and_the_newest_choice_wins()
    {
        var sub = $"set-{Guid.NewGuid():N}";
        var phone = ClientFor(sub, "phone");
        var laptop = ClientFor(sub, "laptop");
        // the person exists once they have a profile
        await phone.PutAsJsonAsync("/me", new { displayName = "Sam" });
        Assert.Empty(await ReadAsync(phone));

        var at = DateTimeOffset.UtcNow.AddMinutes(-10);
        var put = await phone.PutAsJsonAsync("/me/settings", Asking(("theme", "dark", at), ("lang", "nl", at)));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.Equal("dark", (await put.Content.ReadFromJsonAsync<Held>())!.Settings["theme"].Value);

        var read = await ReadAsync(laptop);
        Assert.Equal("dark", read["theme"].Value);
        Assert.Equal(at, read["theme"].At);
        Assert.Equal("nl", read["lang"].Value);

        // an older choice loses, a newer one wins — and only for the setting it names
        await laptop.PutAsJsonAsync("/me/settings", Asking(("theme", "light", at.AddMinutes(-5))));
        Assert.Equal("dark", (await ReadAsync(phone))["theme"].Value);
        await laptop.PutAsJsonAsync("/me/settings", Asking(("theme", "light", at.AddMinutes(5))));
        read = await ReadAsync(phone);
        Assert.Equal("light", read["theme"].Value);
        Assert.Equal("nl", read["lang"].Value);
    }

    [Fact]
    public async Task Back_to_the_default_is_a_choice_too_and_a_clock_running_ahead_is_held_to_now()
    {
        var client = ClientFor($"set-{Guid.NewGuid():N}");
        await client.PutAsJsonAsync("/me", new { displayName = "Sam" });
        var at = DateTimeOffset.UtcNow.AddMinutes(-10);
        await client.PutAsJsonAsync("/me/settings", Asking(("theme", "dark", at)));

        await client.PutAsJsonAsync("/me/settings", Asking(("theme", null, DateTimeOffset.UtcNow.AddDays(2))));
        var held = (await ReadAsync(client))["theme"];
        Assert.Null(held.Value);
        Assert.True(held.At <= DateTimeOffset.UtcNow && held.At > at);
    }

    [Fact]
    public async Task One_person_never_reads_another_persons_settings()
    {
        var mine = ClientFor($"set-{Guid.NewGuid():N}");
        var theirs = ClientFor($"set-{Guid.NewGuid():N}");
        await mine.PutAsJsonAsync("/me", new { displayName = "Sam" });
        await theirs.PutAsJsonAsync("/me", new { displayName = "Kim" });
        await mine.PutAsJsonAsync("/me/settings", Asking(("theme", "dark", DateTimeOffset.UtcNow.AddMinutes(-1))));

        Assert.Empty(await ReadAsync(theirs));
    }

    [Theory]
    [InlineData("")]
    [InlineData("Theme")]
    [InlineData("a b")]
    [InlineData("<script>")]
    [InlineData("munni_theme")]
    public async Task A_setting_that_is_not_a_name_is_refused(string key)
    {
        var client = ClientFor($"set-{Guid.NewGuid():N}");
        await client.PutAsJsonAsync("/me", new { displayName = "Sam" });

        var put = await client.PutAsJsonAsync("/me/settings", Asking((key, "x", DateTimeOffset.UtcNow)));

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
    }

    [Fact]
    public async Task Nothing_asked_too_long_a_value_and_too_many_settings_are_refused()
    {
        var client = ClientFor($"set-{Guid.NewGuid():N}");
        await client.PutAsJsonAsync("/me", new { displayName = "Sam" });
        var now = DateTimeOffset.UtcNow;

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/me/settings", new AccountSettingsRequest(null))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/me/settings", new AccountSettingsRequest([]))).StatusCode);
        var longValue = new string('x', AccountSettings.MaxValueLength + 1);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/me/settings", Asking(("theme", longValue, now)))).StatusCode);
        var many = Enumerable.Range(0, AccountSettings.MaxKeys + 1).Select(i => ($"key{i}", (string?)"x", now)).ToArray();
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/me/settings", Asking(many))).StatusCode);
    }

    [Fact]
    public void The_map_holds_a_bounded_number_of_settings_and_reads_a_broken_one_as_empty()
    {
        var now = DateTimeOffset.UtcNow;
        var full = Enumerable.Range(0, AccountSettings.MaxKeys).ToDictionary(i => $"key{i}", _ => new SettingEntry("x", now.AddMinutes(-5)));
        var stored = AccountSettings.Merged(null, full, now)!;
        Assert.Equal(AccountSettings.MaxKeys, AccountSettings.Read(stored).Count);

        // a full map takes no new name, but a held one still moves
        Assert.Null(AccountSettings.Merged(stored, new Dictionary<string, SettingEntry> { ["extra"] = new("y", now) }, now));
        var moved = AccountSettings.Merged(stored, new Dictionary<string, SettingEntry> { ["key0"] = new("y", now) }, now)!;
        Assert.Equal("y", AccountSettings.Read(moved)["key0"].Value);

        Assert.Empty(AccountSettings.Read("{not json"));
        Assert.Empty(AccountSettings.Read(null));
    }
}
