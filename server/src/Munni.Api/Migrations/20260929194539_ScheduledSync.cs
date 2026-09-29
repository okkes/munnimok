using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class ScheduledSync : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "KeptBundle",
                table: "ConnectorSessions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastScheduleError",
                table: "ConnectorSessions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastScheduledSyncAt",
                table: "ConnectorSessions",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "KeptBundle",
                table: "ConnectorSessions");

            migrationBuilder.DropColumn(
                name: "LastScheduleError",
                table: "ConnectorSessions");

            migrationBuilder.DropColumn(
                name: "LastScheduledSyncAt",
                table: "ConnectorSessions");
        }
    }
}
