using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.GoCardless;
using Munni.Api.Push;
using Munni.Api.Social;

namespace Munni.Api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Space> Spaces => Set<Space>();
    public DbSet<SpaceMember> SpaceMembers => Set<SpaceMember>();
    public DbSet<SyncOpRow> SyncOps => Set<SyncOpRow>();
    public DbSet<EntityRow> EntityRows => Set<EntityRow>();
    public DbSet<GcRequisition> GcRequisitions => Set<GcRequisition>();
    public DbSet<GcLinkedAccount> GcLinkedAccounts => Set<GcLinkedAccount>();
    public DbSet<Friendship> Friendships => Set<Friendship>();
    public DbSet<SpaceInvite> SpaceInvites => Set<SpaceInvite>();
    public DbSet<PushSubscriptionRow> PushSubscriptions => Set<PushSubscriptionRow>();
    public DbSet<FeedSpace> FeedSpaces => Set<FeedSpace>();
    public DbSet<SpaceAccountLink> SpaceAccountLinks => Set<SpaceAccountLink>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.Sub).IsUnique();
        });
        modelBuilder.Entity<Space>(e => e.HasKey(x => x.Id));
        modelBuilder.Entity<SpaceMember>(e =>
        {
            e.HasKey(x => new { x.SpaceId, x.UserId });
            e.HasIndex(x => x.UserId);
        });
        modelBuilder.Entity<SyncOpRow>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.SpaceId, x.Seq }).IsUnique();
            e.HasIndex(x => new { x.SpaceId, x.OpId }).IsUnique();
        });
        modelBuilder.Entity<EntityRow>(e => e.HasKey(x => new { x.SpaceId, x.Entity, x.EntityId }));
        modelBuilder.Entity<GcRequisition>(e => e.HasKey(x => x.Id));
        modelBuilder.Entity<GcLinkedAccount>(e =>
        {
            e.HasKey(x => x.GcAccountId);
            e.HasIndex(x => x.SpaceId);
        });
        modelBuilder.Entity<Friendship>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.UserAId, x.UserBId }).IsUnique();
        });
        modelBuilder.Entity<SpaceInvite>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.ToUserId);
        });
        modelBuilder.Entity<PushSubscriptionRow>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.Endpoint).IsUnique();
            e.HasIndex(x => x.UserId);
        });
        modelBuilder.Entity<FeedSpace>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.OwnerUserId);
        });
        modelBuilder.Entity<SpaceAccountLink>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.SpaceId, x.FeedSpaceId, x.AccountId }).IsUnique();
            e.HasIndex(x => x.FeedSpaceId);
        });
    }
}

public class User
{
    public Guid Id { get; set; }
    /// <summary>OIDC subject (Logto) or test-mode identifier.</summary>
    public required string Sub { get; set; }
    public string? Email { get; set; }
    /// <summary>shown to friends/space members; set by the client after login</summary>
    public string? DisplayName { get; set; }
    /// <summary>avatar preset id ("icon|color"), chosen on the profile screen</summary>
    public string? Picture { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class Space
{
    /// <summary>Client-generated id (uuidv7); the unit of sharing and sync.</summary>
    public required string Id { get; set; }
    /// <summary>Monotonic per-space sequence used purely as a pull cursor.</summary>
    public long LastSeq { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class SpaceMember
{
    public required string SpaceId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; } // owner | member
}

public class SyncOpRow
{
    public long Id { get; set; }
    public required string SpaceId { get; set; }
    public long Seq { get; set; }
    public required string OpId { get; set; }
    public Guid? UserId { get; set; }
    public required string Entity { get; set; }
    public required string EntityId { get; set; }
    public required string Hlc { get; set; }
    /// <summary>JSON-serialized fields dictionary.</summary>
    public required string PayloadJson { get; set; }
    public bool Deleted { get; set; }
    public DateTimeOffset ReceivedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Domain-agnostic materialized state — the server never interprets the
/// app's entities, it only merges and relays them.
/// </summary>
public class EntityRow
{
    public required string SpaceId { get; set; }
    public required string Entity { get; set; }
    public required string EntityId { get; set; }
    public bool Deleted { get; set; }
    public required string DataJson { get; set; }
    public required string FieldVersionsJson { get; set; }
}
