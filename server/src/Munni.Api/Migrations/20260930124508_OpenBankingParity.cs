using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class OpenBankingParity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ScheduleNotBefore",
                table: "ConnectorSessions",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ConnectionId",
                table: "ConnectorAccountRefs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "Excluded",
                table: "ConnectorAccountRefs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "ConnectorPendingTxs",
                columns: table => new
                {
                    AccountRefId = table.Column<string>(type: "text", nullable: false),
                    EntityId = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConnectorPendingTxs", x => new { x.AccountRefId, x.EntityId });
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConnectorPendingTxs");

            migrationBuilder.DropColumn(
                name: "ScheduleNotBefore",
                table: "ConnectorSessions");

            migrationBuilder.DropColumn(
                name: "ConnectionId",
                table: "ConnectorAccountRefs");

            migrationBuilder.DropColumn(
                name: "Excluded",
                table: "ConnectorAccountRefs");
        }
    }
}
