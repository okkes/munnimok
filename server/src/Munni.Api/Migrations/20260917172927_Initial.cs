using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AppSettings",
                columns: table => new
                {
                    Key = table.Column<string>(type: "text", nullable: false),
                    Value = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AppSettings", x => x.Key);
                });

            migrationBuilder.CreateTable(
                name: "EntityRows",
                columns: table => new
                {
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    Entity = table.Column<string>(type: "text", nullable: false),
                    EntityId = table.Column<string>(type: "text", nullable: false),
                    Deleted = table.Column<bool>(type: "boolean", nullable: false),
                    DataJson = table.Column<string>(type: "text", nullable: false),
                    FieldVersionsJson = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EntityRows", x => new { x.SpaceId, x.Entity, x.EntityId });
                });

            migrationBuilder.CreateTable(
                name: "FeedOwners",
                columns: table => new
                {
                    FeedSpaceId = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RequisitionId = table.Column<Guid>(type: "uuid", nullable: true),
                    GcAccountId = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeedOwners", x => new { x.FeedSpaceId, x.UserId });
                });

            migrationBuilder.CreateTable(
                name: "FeedSpaces",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    OwnerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    AccountRef = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeedSpaces", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Friendships",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserAId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserBId = table.Column<Guid>(type: "uuid", nullable: false),
                    RequestedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: true),
                    SpaceRole = table.Column<string>(type: "text", nullable: true),
                    SpaceName = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Friendships", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GcInstitutionLogos",
                columns: table => new
                {
                    InstitutionId = table.Column<string>(type: "text", nullable: false),
                    LogoUrl = table.Column<string>(type: "text", nullable: false),
                    ContentType = table.Column<string>(type: "text", nullable: true),
                    Bytes = table.Column<byte[]>(type: "bytea", nullable: true),
                    FetchedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GcInstitutionLogos", x => x.InstitutionId);
                });

            migrationBuilder.CreateTable(
                name: "GcLinkedAccounts",
                columns: table => new
                {
                    GcAccountId = table.Column<string>(type: "text", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    AccountEntityId = table.Column<string>(type: "text", nullable: false),
                    Iban = table.Column<string>(type: "text", nullable: false),
                    Currency = table.Column<string>(type: "text", nullable: false),
                    RequisitionId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    LastFetchAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    HistoryBackfilledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    DailySuccessLimit = table.Column<int>(type: "integer", nullable: true),
                    SuccessRemaining = table.Column<int>(type: "integer", nullable: true),
                    RateResetAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastFetchReceived = table.Column<int>(type: "integer", nullable: true),
                    LastFetchDropped = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GcLinkedAccounts", x => x.GcAccountId);
                });

            migrationBuilder.CreateTable(
                name: "GcPendingTxs",
                columns: table => new
                {
                    GcAccountId = table.Column<string>(type: "text", nullable: false),
                    EntityId = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GcPendingTxs", x => new { x.GcAccountId, x.EntityId });
                });

            migrationBuilder.CreateTable(
                name: "GcRequisitions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    InstitutionId = table.Column<string>(type: "text", nullable: false),
                    RequisitionId = table.Column<string>(type: "text", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    AppScheme = table.Column<string>(type: "text", nullable: true),
                    RedirectOrigin = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GcRequisitions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProviderQuotas",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    Scope = table.Column<string>(type: "text", nullable: false),
                    Limit = table.Column<int>(type: "integer", nullable: true),
                    Remaining = table.Column<int>(type: "integer", nullable: true),
                    ResetAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CapturedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProviderQuotas", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PushSubscriptions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "text", nullable: false),
                    Endpoint = table.Column<string>(type: "text", nullable: false),
                    P256dh = table.Column<string>(type: "text", nullable: true),
                    Auth = table.Column<string>(type: "text", nullable: true),
                    Lang = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PushSubscriptions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SpaceAccountLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    FeedSpaceId = table.Column<string>(type: "text", nullable: false),
                    AccountId = table.Column<string>(type: "text", nullable: false),
                    AttachedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    HistoryFrom = table.Column<string>(type: "text", nullable: false),
                    Type = table.Column<string>(type: "text", nullable: false),
                    Archived = table.Column<bool>(type: "boolean", nullable: false),
                    ArchivedAtSeq = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SpaceAccountLinks", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SpaceInvites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    FromUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ToUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Role = table.Column<string>(type: "text", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    SpaceName = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SpaceInvites", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SpaceMembers",
                columns: table => new
                {
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Role = table.Column<string>(type: "text", nullable: false),
                    JoinedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SpaceMembers", x => new { x.SpaceId, x.UserId });
                });

            migrationBuilder.CreateTable(
                name: "Spaces",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    LastSeq = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Spaces", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SplitEntries",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    Kind = table.Column<string>(type: "text", nullable: false),
                    PaidByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Description = table.Column<string>(type: "text", nullable: false),
                    AmountCents = table.Column<long>(type: "bigint", nullable: false),
                    Date = table.Column<string>(type: "text", nullable: false),
                    SharesJson = table.Column<string>(type: "text", nullable: false),
                    SourceTxId = table.Column<string>(type: "text", nullable: true),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitEntries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SplitInvites",
                columns: table => new
                {
                    Token = table.Column<string>(type: "text", nullable: false),
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitInvites", x => x.Token);
                });

            migrationBuilder.CreateTable(
                name: "SplitMembers",
                columns: table => new
                {
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Role = table.Column<string>(type: "text", nullable: false),
                    AttachedSpaceId = table.Column<string>(type: "text", nullable: true),
                    AttachedEventId = table.Column<string>(type: "text", nullable: true),
                    JoinedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitMembers", x => new { x.SplitId, x.UserId });
                });

            migrationBuilder.CreateTable(
                name: "Splits",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    Currency = table.Column<string>(type: "text", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Splits", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "StoreConnCiphers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Store = table.Column<string>(type: "text", nullable: false),
                    Cipher = table.Column<string>(type: "text", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StoreConnCiphers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "StoreSyncDevices",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceId = table.Column<string>(type: "text", nullable: false),
                    PublicJwk = table.Column<string>(type: "text", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    WrappedCsk = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StoreSyncDevices", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SyncOps",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    Seq = table.Column<long>(type: "bigint", nullable: false),
                    OpId = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Entity = table.Column<string>(type: "text", nullable: false),
                    EntityId = table.Column<string>(type: "text", nullable: false),
                    Hlc = table.Column<string>(type: "text", nullable: false),
                    PayloadJson = table.Column<string>(type: "text", nullable: false),
                    Deleted = table.Column<bool>(type: "boolean", nullable: false),
                    ReceivedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncOps", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "UserDevices",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Platform = table.Column<string>(type: "text", nullable: true),
                    Name = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserDevices", x => new { x.UserId, x.Id });
                });

            migrationBuilder.CreateTable(
                name: "Users",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Sub = table.Column<string>(type: "text", nullable: false),
                    Email = table.Column<string>(type: "text", nullable: true),
                    DisplayName = table.Column<string>(type: "text", nullable: true),
                    Picture = table.Column<string>(type: "text", nullable: true),
                    Country = table.Column<string>(type: "text", nullable: true),
                    DisplayCurrency = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Users", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FeedOwners_UserId",
                table: "FeedOwners",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_FeedSpaces_OwnerUserId",
                table: "FeedSpaces",
                column: "OwnerUserId");

            migrationBuilder.CreateIndex(
                name: "IX_Friendships_UserAId_UserBId",
                table: "Friendships",
                columns: new[] { "UserAId", "UserBId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GcLinkedAccounts_SpaceId",
                table: "GcLinkedAccounts",
                column: "SpaceId");

            migrationBuilder.CreateIndex(
                name: "IX_ProviderQuotas_Provider_Scope",
                table: "ProviderQuotas",
                columns: new[] { "Provider", "Scope" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PushSubscriptions_Endpoint",
                table: "PushSubscriptions",
                column: "Endpoint",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PushSubscriptions_UserId",
                table: "PushSubscriptions",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_SpaceAccountLinks_FeedSpaceId",
                table: "SpaceAccountLinks",
                column: "FeedSpaceId");

            migrationBuilder.CreateIndex(
                name: "IX_SpaceAccountLinks_SpaceId_FeedSpaceId_AccountId",
                table: "SpaceAccountLinks",
                columns: new[] { "SpaceId", "FeedSpaceId", "AccountId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SpaceInvites_ToUserId",
                table: "SpaceInvites",
                column: "ToUserId");

            migrationBuilder.CreateIndex(
                name: "IX_SpaceMembers_UserId",
                table: "SpaceMembers",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_SplitEntries_SplitId",
                table: "SplitEntries",
                column: "SplitId");

            migrationBuilder.CreateIndex(
                name: "IX_SplitInvites_SplitId",
                table: "SplitInvites",
                column: "SplitId");

            migrationBuilder.CreateIndex(
                name: "IX_SplitMembers_UserId",
                table: "SplitMembers",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_StoreConnCiphers_UserId_Store",
                table: "StoreConnCiphers",
                columns: new[] { "UserId", "Store" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_StoreSyncDevices_UserId_DeviceId",
                table: "StoreSyncDevices",
                columns: new[] { "UserId", "DeviceId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncOps_SpaceId_OpId",
                table: "SyncOps",
                columns: new[] { "SpaceId", "OpId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncOps_SpaceId_Seq",
                table: "SyncOps",
                columns: new[] { "SpaceId", "Seq" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Users_Sub",
                table: "Users",
                column: "Sub",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AppSettings");

            migrationBuilder.DropTable(
                name: "EntityRows");

            migrationBuilder.DropTable(
                name: "FeedOwners");

            migrationBuilder.DropTable(
                name: "FeedSpaces");

            migrationBuilder.DropTable(
                name: "Friendships");

            migrationBuilder.DropTable(
                name: "GcInstitutionLogos");

            migrationBuilder.DropTable(
                name: "GcLinkedAccounts");

            migrationBuilder.DropTable(
                name: "GcPendingTxs");

            migrationBuilder.DropTable(
                name: "GcRequisitions");

            migrationBuilder.DropTable(
                name: "ProviderQuotas");

            migrationBuilder.DropTable(
                name: "PushSubscriptions");

            migrationBuilder.DropTable(
                name: "SpaceAccountLinks");

            migrationBuilder.DropTable(
                name: "SpaceInvites");

            migrationBuilder.DropTable(
                name: "SpaceMembers");

            migrationBuilder.DropTable(
                name: "Spaces");

            migrationBuilder.DropTable(
                name: "SplitEntries");

            migrationBuilder.DropTable(
                name: "SplitInvites");

            migrationBuilder.DropTable(
                name: "SplitMembers");

            migrationBuilder.DropTable(
                name: "Splits");

            migrationBuilder.DropTable(
                name: "StoreConnCiphers");

            migrationBuilder.DropTable(
                name: "StoreSyncDevices");

            migrationBuilder.DropTable(
                name: "SyncOps");

            migrationBuilder.DropTable(
                name: "UserDevices");

            migrationBuilder.DropTable(
                name: "Users");
        }
    }
}
