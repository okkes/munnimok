using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class OpenBankingRetired : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
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

            migrationBuilder.DropColumn(
                name: "GcAccountId",
                table: "FeedOwners");

            migrationBuilder.DropColumn(
                name: "RequisitionId",
                table: "FeedOwners");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "GcAccountId",
                table: "FeedOwners",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "RequisitionId",
                table: "FeedOwners",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "GcInstitutionLogos",
                columns: table => new
                {
                    InstitutionId = table.Column<string>(type: "text", nullable: false),
                    Bytes = table.Column<byte[]>(type: "bytea", nullable: true),
                    ContentType = table.Column<string>(type: "text", nullable: true),
                    FetchedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LogoUrl = table.Column<string>(type: "text", nullable: false)
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
                    AccountEntityId = table.Column<string>(type: "text", nullable: false),
                    Currency = table.Column<string>(type: "text", nullable: false),
                    DailySuccessLimit = table.Column<int>(type: "integer", nullable: true),
                    HistoryBackfilledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    Iban = table.Column<string>(type: "text", nullable: false),
                    LastFetchAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastFetchDropped = table.Column<int>(type: "integer", nullable: true),
                    LastFetchReceived = table.Column<int>(type: "integer", nullable: true),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    RateResetAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RequisitionId = table.Column<Guid>(type: "uuid", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    SuccessRemaining = table.Column<int>(type: "integer", nullable: true)
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
                    AppScheme = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    InstitutionId = table.Column<string>(type: "text", nullable: false),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    RedirectOrigin = table.Column<string>(type: "text", nullable: true),
                    RequisitionId = table.Column<string>(type: "text", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false)
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
                    CapturedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Limit = table.Column<int>(type: "integer", nullable: true),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    Remaining = table.Column<int>(type: "integer", nullable: true),
                    ResetAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    Scope = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProviderQuotas", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_GcLinkedAccounts_SpaceId",
                table: "GcLinkedAccounts",
                column: "SpaceId");

            migrationBuilder.CreateIndex(
                name: "IX_ProviderQuotas_Provider_Scope",
                table: "ProviderQuotas",
                columns: new[] { "Provider", "Scope" },
                unique: true);
        }
    }
}
