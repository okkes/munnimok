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
    public DbSet<Friendship> Friendships => Set<Friendship>();
    public DbSet<SpaceInvite> SpaceInvites => Set<SpaceInvite>();
    public DbSet<PushSubscriptionRow> PushSubscriptions => Set<PushSubscriptionRow>();
    public DbSet<FeedSpace> FeedSpaces => Set<FeedSpace>();
    public DbSet<FeedOwner> FeedOwners => Set<FeedOwner>();
    public DbSet<SpaceAccountLink> SpaceAccountLinks => Set<SpaceAccountLink>();
    public DbSet<AppSetting> AppSettings => Set<AppSetting>();
    public DbSet<ConnectionSyncDevice> ConnectionSyncDevices => Set<ConnectionSyncDevice>();
    public DbSet<UserDevice> UserDevices => Set<UserDevice>();
    public DbSet<ConnectionCipher> ConnectionCiphers => Set<ConnectionCipher>();
    public DbSet<Split> Splits => Set<Split>();
    public DbSet<SplitMember> SplitMembers => Set<SplitMember>();
    public DbSet<SplitEntry> SplitEntries => Set<SplitEntry>();
    public DbSet<SplitInvite> SplitInvites => Set<SplitInvite>();
    public DbSet<ConnectorSession> ConnectorSessions => Set<ConnectorSession>();
    public DbSet<ConnectorAccountRef> ConnectorAccountRefs => Set<ConnectorAccountRef>();
    public DbSet<ConnectorPendingTx> ConnectorPendingTxs => Set<ConnectorPendingTx>();
    /// <summary>The operator's own connections from the lab's test bench (#441 L2). See <see cref="Munni.Api.Lab.LabSession"/>.</summary>
    public DbSet<Munni.Api.Lab.LabSession> LabSessions => Set<Munni.Api.Lab.LabSession>();

    public DbSet<Munni.Api.Lab.LabRetentionRun> LabRetentionRuns => Set<Munni.Api.Lab.LabRetentionRun>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
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
    }
}

/// <summary>
/// A split session (settleup-splits design): Splitwise-style group
/// ledger with membership INDEPENDENT of spaces. Server-resident and
/// online-only by design — guests must never touch space scopes.
/// </summary>
public class Split
{
    /// <summary>client-generated id (uuidv7)</summary>
    public required string Id { get; set; }
    public required string Name { get; set; }
    /// <summary>fixed at creation (user decision Q2)</summary>
    public required string Currency { get; set; }
    public string Status { get; set; } = "open"; // open | settled
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class SplitMember
{
    public required string SplitId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; } // owner | member
    /// <summary>the member's OWN space this split is wired to (per-member
    /// attachment, user clarification) — personal, only ever shown to them</summary>
    public string? AttachedSpaceId { get; set; }
    /// <summary>the member's OWN event (in their attached space) — SP5;
    /// personal wiring like the space, never shown to other members</summary>
    public string? AttachedEventId { get; set; }
    public DateTimeOffset JoinedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class SplitEntry
{
    /// <summary>client-generated id (uuidv7)</summary>
    public required string Id { get; set; }
    public required string SplitId { get; set; }
    public string Kind { get; set; } = "expense"; // expense | settlement
    public Guid PaidByUserId { get; set; }
    public required string Description { get; set; }
    /// <summary>positive cents in the split's currency</summary>
    public long AmountCents { get; set; }
    /// <summary>yyyy-mm-dd</summary>
    public required string Date { get; set; }
    /// <summary>JSON [{userId,cents}] — ALWAYS materialized at entry
    /// creation (an equal split is computed over the member set of that
    /// moment and stored), so later joins never rewrite history</summary>
    public required string SharesJson { get; set; }
    /// <summary>backlink to the adder's space transaction (SP2) — only ever shown to the adder</summary>
    public string? SourceTxId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Share-link invite (SP3): any member can mint one; the link joins
/// ANYONE — no friendship required, no space access granted. Multi-use
/// while valid; minting a new link retires the split's previous one.
/// The token is the whole secret, so it's long and random.
/// </summary>
public class SplitInvite
{
    public required string Token { get; set; }
    public required string SplitId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; }
}

/// <summary>operator-editable server-wide settings (the catalog document, …)</summary>
public class AppSetting
{
    public required string Key { get; set; }
    public required string Value { get; set; }
}

/// <summary>a device's public key for E2EE store-connection sync (SC1);
/// WrappedCsk is the sync key encrypted TO this device by another one —
/// the server can store it but never open it</summary>
/// <summary>
/// One signed-in device per user (logged-in-devices plan): stamped on
/// every authenticated request (throttled), revocable — a revoked
/// device's next request answers 410 and the client wipes itself.
/// </summary>
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

/// <summary>A device enrolled in connection sync: its public key and the
/// Connection Sync Key wrapped to it (null until another device approves)</summary>
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

/// <summary>AES-GCM ciphertext of one connection's credential bundle —
/// opaque to the server by design</summary>
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
    /// <summary>shown to friends/space members; set by the client after login</summary>
    public string? DisplayName { get; set; }
    /// <summary>avatar preset id ("icon|color"), chosen on the profile screen</summary>
    public string? Picture { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country of use — feeds category prediction</summary>
    public string? Country { get; set; }
    /// <summary>ISO 4217 display currency (currency plan CD3) — null = "as recorded", no conversion</summary>
    public string? DisplayCurrency { get; set; }
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
    public required string Role { get; set; } // owner | contributor | reader (SpaceRoles)
    /// <summary>#172 "member since"</summary>
    public DateTimeOffset JoinedAt { get; set; } = DateTimeOffset.UtcNow;
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
