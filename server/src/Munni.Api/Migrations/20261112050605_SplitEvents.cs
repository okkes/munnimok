using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class SplitEvents : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ArchivedAt",
                table: "Splits",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DeleteAt",
                table: "Splits",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DeleteBy",
                table: "Splits",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "EndDate",
                table: "Splits",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Picture",
                table: "Splits",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "SettledAt",
                table: "Splits",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "StartDate",
                table: "Splits",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LeftAt",
                table: "SplitMembers",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "State",
                table: "SplitMembers",
                type: "text",
                nullable: false,
                // everyone in an event today is in it
                defaultValue: "active");

            migrationBuilder.AddColumn<int>(
                name: "MaxUses",
                table: "SplitInvites",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "NeedsApproval",
                table: "SplitInvites",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "Uses",
                table: "SplitInvites",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "HasReceipt",
                table: "SplitEntries",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<long>(
                name: "OriginalCents",
                table: "SplitEntries",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OriginalCurrency",
                table: "SplitEntries",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ShareMode",
                table: "SplitEntries",
                type: "text",
                nullable: false,
                // how an old entry's shares were given is not known: its stored cents are exact amounts either way
                defaultValue: "exact");

            migrationBuilder.AddColumn<string>(
                name: "SourceSpaceId",
                table: "SplitEntries",
                type: "text",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "SplitFriendInvites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    FromUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ToUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    AnsweredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitFriendInvites", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SplitJoinRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    AnsweredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitJoinRequests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SplitPayments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    FromUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ToUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    AmountCents = table.Column<long>(type: "bigint", nullable: false),
                    PaidAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitPayments", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SplitReceipts",
                columns: table => new
                {
                    EntryId = table.Column<string>(type: "text", nullable: false),
                    SplitId = table.Column<string>(type: "text", nullable: false),
                    Image = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SplitReceipts", x => x.EntryId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SplitFriendInvites_SplitId",
                table: "SplitFriendInvites",
                column: "SplitId");

            migrationBuilder.CreateIndex(
                name: "IX_SplitFriendInvites_ToUserId",
                table: "SplitFriendInvites",
                column: "ToUserId");

            migrationBuilder.CreateIndex(
                name: "IX_SplitJoinRequests_SplitId_UserId",
                table: "SplitJoinRequests",
                columns: new[] { "SplitId", "UserId" });

            migrationBuilder.CreateIndex(
                name: "IX_SplitPayments_SplitId",
                table: "SplitPayments",
                column: "SplitId");

            migrationBuilder.CreateIndex(
                name: "IX_SplitReceipts_SplitId",
                table: "SplitReceipts",
                column: "SplitId");

            // who joined after the creator is a contributor now; and an event its owner closed before settling
            // had a plan of payments was closed for good — "settled" now means that plan is being paid
            migrationBuilder.Sql("""
                UPDATE "SplitMembers" SET "Role" = 'contributor' WHERE "Role" = 'member';
                UPDATE "Splits" SET "Status" = 'archived', "ArchivedAt" = now() WHERE "Status" = 'settled';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SplitFriendInvites");

            migrationBuilder.DropTable(
                name: "SplitJoinRequests");

            migrationBuilder.DropTable(
                name: "SplitPayments");

            migrationBuilder.DropTable(
                name: "SplitReceipts");

            migrationBuilder.DropColumn(
                name: "ArchivedAt",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "DeleteAt",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "DeleteBy",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "EndDate",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "Picture",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "SettledAt",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "StartDate",
                table: "Splits");

            migrationBuilder.DropColumn(
                name: "LeftAt",
                table: "SplitMembers");

            migrationBuilder.DropColumn(
                name: "State",
                table: "SplitMembers");

            migrationBuilder.DropColumn(
                name: "MaxUses",
                table: "SplitInvites");

            migrationBuilder.DropColumn(
                name: "NeedsApproval",
                table: "SplitInvites");

            migrationBuilder.DropColumn(
                name: "Uses",
                table: "SplitInvites");

            migrationBuilder.DropColumn(
                name: "HasReceipt",
                table: "SplitEntries");

            migrationBuilder.DropColumn(
                name: "OriginalCents",
                table: "SplitEntries");

            migrationBuilder.DropColumn(
                name: "OriginalCurrency",
                table: "SplitEntries");

            migrationBuilder.DropColumn(
                name: "ShareMode",
                table: "SplitEntries");

            migrationBuilder.DropColumn(
                name: "SourceSpaceId",
                table: "SplitEntries");
        }
    }
}
