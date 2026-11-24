using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Connectors;
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
    public DbSet<ErasedSpace> ErasedSpaces => Set<ErasedSpace>();
    public DbSet<Friendship> Friendships => Set<Friendship>();
    public DbSet<SpaceInvite> SpaceInvites => Set<SpaceInvite>();
    public DbSet<PushSubscriptionRow> PushSubscriptions => Set<PushSubscriptionRow>();
    public DbSet<FeedSpace> FeedSpaces => Set<FeedSpace>();
    public DbSet<FeedOwner> FeedOwners => Set<FeedOwner>();
    public DbSet<SpaceAccountLink> SpaceAccountLinks => Set<SpaceAccountLink>();
    public DbSet<SpaceStoreLink> SpaceStoreLinks => Set<SpaceStoreLink>();
    public DbSet<AppSetting> AppSettings => Set<AppSetting>();
    public DbSet<ConnectionSyncDevice> ConnectionSyncDevices => Set<ConnectionSyncDevice>();
    public DbSet<UserDevice> UserDevices => Set<UserDevice>();
    public DbSet<ConnectionCipher> ConnectionCiphers => Set<ConnectionCipher>();
    public DbSet<Split> Splits => Set<Split>();
    public DbSet<SplitMember> SplitMembers => Set<SplitMember>();
    public DbSet<SplitEntry> SplitEntries => Set<SplitEntry>();
    public DbSet<SplitInvite> SplitInvites => Set<SplitInvite>();
    public DbSet<SplitJoinRequest> SplitJoinRequests => Set<SplitJoinRequest>();
    public DbSet<SplitFriendInvite> SplitFriendInvites => Set<SplitFriendInvite>();
    public DbSet<SplitPayment> SplitPayments => Set<SplitPayment>();
    public DbSet<SplitReceipt> SplitReceipts => Set<SplitReceipt>();
    public DbSet<ConnectorSession> ConnectorSessions => Set<ConnectorSession>();
    public DbSet<ConnectorAccountRef> ConnectorAccountRefs => Set<ConnectorAccountRef>();
    public DbSet<ConnectorPendingTx> ConnectorPendingTxs => Set<ConnectorPendingTx>();
    public DbSet<Munni.Api.Lab.LabSession> LabSessions => Set<Munni.Api.Lab.LabSession>();

    public DbSet<Munni.Api.Lab.LabRetentionRun> LabRetentionRuns => Set<Munni.Api.Lab.LabRetentionRun>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDbFunction(typeof(DbText).GetMethod(nameof(DbText.OctetLength), [typeof(string)])!).HasName("octet_length").IsBuiltIn();

        modelBuilder.Entity<ConnectorSession>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.UserId);
            // one row per connection: a re-login replaces the session
            e.HasIndex(x => new { x.UserId, x.Provider, x.ConnectionId }).IsUnique();
        });
        modelBuilder.Entity<ConnectorAccountRef>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.UserId);
        });
        modelBuilder.Entity<Munni.Api.Lab.LabSession>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.UserId);
        });
        modelBuilder.Entity<Munni.Api.Lab.LabRetentionRun>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.AgentId);
        });
        modelBuilder.Entity<ConnectorPendingTx>(e => e.HasKey(x => new { x.AccountRefId, x.EntityId }));
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
        modelBuilder.Entity<ErasedSpace>(e => e.HasKey(x => x.SpaceId));
        modelBuilder.Entity<UserDevice>(e =>
        {
            // the same physical device can serve several accounts
            e.HasKey(x => new { x.UserId, x.Id });
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
        modelBuilder.Entity<FeedOwner>(e =>
        {
            e.HasKey(x => new { x.FeedSpaceId, x.UserId });
            e.HasIndex(x => x.UserId);
        });
        modelBuilder.Entity<SpaceAccountLink>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.SpaceId, x.FeedSpaceId, x.AccountId }).IsUnique();
            e.HasIndex(x => x.FeedSpaceId);
        });
        modelBuilder.Entity<SpaceStoreLink>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.SpaceId, x.FeedSpaceId }).IsUnique();
            e.HasIndex(x => x.FeedSpaceId);
        });
        modelBuilder.Entity<AppSetting>(e => e.HasKey(x => x.Key));
        modelBuilder.Entity<ConnectionSyncDevice>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.UserId, x.DeviceId }).IsUnique();
        });
        modelBuilder.Entity<ConnectionCipher>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.UserId, x.ConnectionId }).IsUnique();
        });
        modelBuilder.Entity<Split>(e => e.HasKey(x => x.Id));
        modelBuilder.Entity<SplitMember>(e =>
        {
            e.HasKey(x => new { x.SplitId, x.UserId });
            e.HasIndex(x => x.UserId);
        });
        modelBuilder.Entity<SplitEntry>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.SplitId);
        });
        modelBuilder.Entity<SplitInvite>(e =>
        {
            e.HasKey(x => x.Token);
            e.HasIndex(x => x.SplitId);
        });
        modelBuilder.Entity<SplitJoinRequest>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.SplitId, x.UserId });
        });
        modelBuilder.Entity<SplitFriendInvite>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.SplitId);
            e.HasIndex(x => x.ToUserId);
        });
        modelBuilder.Entity<SplitPayment>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.SplitId);
        });
        modelBuilder.Entity<SplitReceipt>(e =>
        {
            e.HasKey(x => x.EntryId);
            e.HasIndex(x => x.SplitId);
        });
    }
}

// Splitwise-style group ledger, membership independent of spaces; server-resident and online-only:
// guests must never touch space scopes
public class Split
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    // fixed at creation
    public required string Currency { get; set; }
    /// <summary>open: running · settled: the plan of payments stands and is being paid · archived: closed for good</summary>
    public string Status { get; set; } = "open";
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    // #538: one of the app's own (a path) or an uploaded one (a downscaled data URL)
    public string? Picture { get; set; }
    /// <summary>yyyy-mm-dd, both optional: an event that has not started is planned, one that ended is over</summary>
    public string? StartDate { get; set; }
    public string? EndDate { get; set; }
    public DateTimeOffset? SettledAt { get; set; }
    public DateTimeOffset? ArchivedAt { get; set; }
    /// <summary>a deletion counting down: the event is gone once this passes, unless an owner stops it</summary>
    public DateTimeOffset? DeleteAt { get; set; }
    public Guid? DeleteBy { get; set; }
}

public class SplitMember
{
    public required string SplitId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; } // owner | contributor
    // someone who went stays in the arithmetic of what they took part in and still reads the event
    public string State { get; set; } = "active";
    public DateTimeOffset? LeftAt { get; set; }
    // the member's OWN space; personal, only ever shown to them
    public string? AttachedSpaceId { get; set; }
    // the member's OWN event in their attached space; personal, never shown to other members
    public string? AttachedEventId { get; set; }
    public DateTimeOffset JoinedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class SplitEntry
{
    public required string Id { get; set; }
    public required string SplitId { get; set; }
    public string Kind { get; set; } = "expense"; // expense | settlement
    public Guid PaidByUserId { get; set; }
    public required string Description { get; set; }
    /// <summary>positive cents in the split's currency</summary>
    public long AmountCents { get; set; }
    public required string Date { get; set; }
    // JSON [{userId,cents}], always materialized at entry creation so later joins never rewrite history
    public required string SharesJson { get; set; }
    // backlink to the adder's space transaction; only ever shown to the adder
    public string? SourceTxId { get; set; }
    // #538: the space that transaction lives in; shown to nobody else
    public string? SourceSpaceId { get; set; }
    /// <summary>how the shares were given: equal | exact | percent — the cents are stored either way</summary>
    public string ShareMode { get; set; } = "equal";
    /// <summary>what was paid in another currency than the event's; AmountCents is what it came to in the event's</summary>
    public string? OriginalCurrency { get; set; }
    public long? OriginalCents { get; set; }
    /// <summary>a photo of the receipt exists — it lives in its own table, so reading entries never drags pictures along</summary>
    public bool HasReceipt { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

// any member can mint one; the link joins anyone, no friendship or space access needed; a new link retires the previous one
public class SplitInvite
{
    public required string Token { get; set; }
    public required string SplitId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    /// <summary>Null: the link does not run out (links from before 5.21 keep their seven days).</summary>
    public DateTimeOffset? ExpiresAt { get; set; }
    /// <summary>#538: how many people the link lets in — 0 = any number; used up, it is as good as gone</summary>
    public int MaxUses { get; set; }
    public int Uses { get; set; }
    public bool NeedsApproval { get; set; }
}

// #538: kept apart from the entry
public class SplitReceipt
{
    public required string EntryId { get; set; }
    public required string SplitId { get; set; }
    public required string Image { get; set; }
}

public class SplitJoinRequest
{
    public Guid Id { get; set; }
    public required string SplitId { get; set; }
    public Guid UserId { get; set; }
    public string Status { get; set; } = "pending"; // pending | approved | refused
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? AnsweredAt { get; set; }
}

public class SplitFriendInvite
{
    public Guid Id { get; set; }
    public required string SplitId { get; set; }
    public Guid FromUserId { get; set; }
    public Guid ToUserId { get; set; }
    public string Status { get; set; } = "pending"; // pending | accepted | declined | cancelled
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? AnsweredAt { get; set; }
}

public class SplitPayment
{
    public Guid Id { get; set; }
    public required string SplitId { get; set; }
    public Guid FromUserId { get; set; }
    public Guid ToUserId { get; set; }
    public long AmountCents { get; set; }
    public DateTimeOffset? PaidAt { get; set; }
}

public class AppSetting
{
    public required string Key { get; set; }
    public required string Value { get; set; }
}

// a revoked device's next request answers 410 and the client wipes itself
public class UserDevice
{
    /// <summary>the client's stable device id (the HLC node id)</summary>
    public required string Id { get; set; }
    public Guid UserId { get; set; }
    /// <summary>web | android | ios (client-declared)</summary>
    public string? Platform { get; set; }
    /// <summary>auto-derived, user-editable (user ruling)</summary>
    public string? Name { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

// public key plus the Connection Sync Key wrapped to it (null until another device approves)
public class ConnectionSyncDevice
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public required string DeviceId { get; set; }
    public required string PublicJwk { get; set; }
    public required string Name { get; set; }
    public string? WrappedCsk { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

// AES-GCM ciphertext, opaque to the server by design
public class ConnectionCipher
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    /// <summary>the relay's stable connection id</summary>
    public required string ConnectionId { get; set; }
    public required string Cipher { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public class User
{
    public Guid Id { get; set; }
    /// <summary>OIDC subject (Logto) or test-mode identifier.</summary>
    public required string Sub { get; set; }
    public string? Email { get; set; }
    public string? DisplayName { get; set; }
    /// <summary>avatar preset id ("icon|color"), chosen on the profile screen</summary>
    public string? Picture { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country of use — feeds category prediction</summary>
    public string? Country { get; set; }
    /// <summary>ISO 4217 display currency (currency plan CD3) — null = "as recorded", no conversion</summary>
    public string? DisplayCurrency { get; set; }
    /// <summary>#580: the in-app notifications up to this moment were cleared on one of the person's devices — the others follow</summary>
    public DateTimeOffset? NotificationsClearedAt { get; set; }
    /// <summary>#614: the same per part of the list the bell shows — a JSON map from "general" or a space id to its moment</summary>
    public string? NotificationsClearedScopes { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class Space
{
    public required string Id { get; set; }
    /// <summary>Monotonic per-space sequence used purely as a pull cursor.</summary>
    public long LastSeq { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class SpaceMember
{
    public required string SpaceId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; } // owner | contributor | reader (SpaceRoles)
    public DateTimeOffset JoinedAt { get; set; } = DateTimeOffset.UtcNow;
    /// <summary>#549: whether this member gets the space's notifications — personal, never shown to the others</summary>
    public bool Notify { get; set; } = true;
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
    public required string PayloadJson { get; set; }
    public bool Deleted { get; set; }
    public DateTimeOffset ReceivedAt { get; set; } = DateTimeOffset.UtcNow;
}

// #615: keeps a device that still holds the deleted space from giving birth to an empty one of the same id on its next push
public class ErasedSpace
{
    public required string SpaceId { get; set; }
    public DateTimeOffset ErasedAt { get; set; } = DateTimeOffset.UtcNow;
}

// the server never interprets the app's entities, it only merges and relays them
public class EntityRow
{
    public required string SpaceId { get; set; }
    public required string Entity { get; set; }
    public required string EntityId { get; set; }
    public bool Deleted { get; set; }
    public required string DataJson { get; set; }
    public required string FieldVersionsJson { get; set; }
}
