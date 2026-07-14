using Munni.Api.Data;

namespace Munni.Api.Banking;

/// <summary>
/// The configured bank-data providers and which one is ACTIVE for new
/// connections (admin-selectable, stored in AppSettings). Existing
/// linked accounts always keep fetching through the provider that
/// created them — switching only affects new consents.
/// </summary>
public sealed class BankProviderRegistry
{
    public const string SettingKey = "bankProvider";

    private readonly Dictionary<string, IBankDataApi> _byId;

    public BankProviderRegistry(IEnumerable<IBankDataApi> providers)
    {
        _byId = providers.ToDictionary(p => p.ProviderId);
    }

    public bool Any => _byId.Count > 0;
    public IReadOnlyCollection<string> ConfiguredIds => _byId.Keys;

    /// <summary>the provider that created a row — unknown/legacy falls back to the first configured</summary>
    public IBankDataApi For(string? providerId) =>
        providerId is not null && _byId.TryGetValue(providerId, out var api) ? api : _byId.Values.First();

    public async Task<IBankDataApi> ActiveAsync(AppDbContext db)
    {
        var setting = await db.AppSettings.FindAsync(SettingKey);
        return For(setting?.Value);
    }

    public async Task<string> ActiveIdAsync(AppDbContext db) => (await ActiveAsync(db)).ProviderId;

    public async Task<bool> SetActiveAsync(AppDbContext db, string providerId)
    {
        if (!_byId.ContainsKey(providerId)) return false;
        var setting = await db.AppSettings.FindAsync(SettingKey);
        if (setting is null) db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = providerId });
        else setting.Value = providerId;
        await db.SaveChangesAsync();
        return true;
    }
}
