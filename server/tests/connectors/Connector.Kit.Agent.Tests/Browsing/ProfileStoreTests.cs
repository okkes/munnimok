using Connector.Kit.Agent.Browsing;
using Connector.Kit.Errors;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Browsing;

/// <summary>
/// The persistent-profile store: one directory per profile on the agent's
/// own disk, a health record beside them that survives a restart, and a
/// wipe that leaves nothing — the store is what a household agent keeps
/// a logged-in browser in, so what it keeps and what it forgets both matter.
/// </summary>
public sealed class ProfileStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "profile-store-tests", Guid.NewGuid().ToString("N"));

    private ProfileStore Store() => new(_root, NullLogger<ProfileStore>.Instance);

    [Fact]
    public void A_profile_gets_its_own_directory_and_starts_healthy()
    {
        var store = Store();

        var directory = store.DirectoryFor("prf_1", "asn");

        Assert.True(Directory.Exists(directory));
        Assert.StartsWith(store.RootDirectory, directory, StringComparison.Ordinal);
        var health = Assert.Single(store.Snapshot());
        Assert.Equal("prf_1", health.Id);
        Assert.Equal("asn", health.Provider);
        Assert.True(health.Healthy);
        Assert.Null(health.LastOk);
    }

    [Fact]
    public void Health_survives_a_restart_and_an_unhealthy_mark_keeps_the_last_good_time()
    {
        var at = new DateTimeOffset(2026, 9, 29, 12, 0, 0, TimeSpan.Zero);
        var first = Store();
        first.MarkOk("prf_1", "asn", at);
        first.MarkUnhealthy("prf_1", "asn");
        first.MarkOk("prf_2", "duo", at.AddHours(1));

        var restarted = Store();
        var snapshot = restarted.Snapshot();

        Assert.Equal(["prf_1", "prf_2"], snapshot.Select(p => p.Id));
        Assert.False(snapshot[0].Healthy);
        Assert.Equal(at, snapshot[0].LastOk);
        Assert.True(snapshot[1].Healthy);
        Assert.Equal(at.AddHours(1), snapshot[1].LastOk);
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("prf 1")]
    [InlineData("")]
    public void An_id_that_is_not_a_plain_path_segment_is_refused(string profileId)
    {
        var store = Store();

        var refused = Assert.Throws<ConnectorException>(() => store.DirectoryFor(profileId, "asn"));

        Assert.Equal(ErrorCode.InvalidRequest, refused.Code);
        Assert.Throws<ConnectorException>(() => store.MarkOk(profileId, "asn", DateTimeOffset.UtcNow));
        Assert.Throws<ConnectorException>(() => store.MarkUnhealthy(profileId, "asn"));
    }

    [Fact]
    public void A_wipe_removes_every_profile_directory_and_the_health_record()
    {
        var store = Store();
        var directory = store.DirectoryFor("prf_1", "asn");
        File.WriteAllText(Path.Combine(directory, "Cookies"), "session");
        store.MarkOk("prf_1", "asn", DateTimeOffset.UtcNow);

        store.WipeAll();

        Assert.False(Directory.Exists(directory));
        Assert.False(File.Exists(Path.Combine(_root, "profiles.json")));
        Assert.Empty(store.Snapshot());
        Assert.Empty(Store().Snapshot());
    }

    [Fact]
    public void An_unreadable_or_foreign_health_record_starts_the_profiles_unknown()
    {
        Directory.CreateDirectory(_root);
        File.WriteAllText(Path.Combine(_root, "profiles.json"), "{ not json");
        Assert.Empty(Store().Snapshot());

        // a record naming an id that is not a legal directory is dropped rather than trusted
        File.WriteAllText(
            Path.Combine(_root, "profiles.json"),
            """[{"id":"../up","provider":"asn","healthy":true,"last_ok":null},{"id":"prf_ok","provider":"asn","healthy":true,"last_ok":null}]""");
        var only = Assert.Single(Store().Snapshot());
        Assert.Equal("prf_ok", only.Id);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
