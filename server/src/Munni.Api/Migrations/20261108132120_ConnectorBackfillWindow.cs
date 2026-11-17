using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    public partial class ConnectorBackfillWindow : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "BackfillSince",
                table: "ConnectorSessions",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "BackfillUntil",
                table: "ConnectorSessions",
                type: "date",
                nullable: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "BackfillSince",
                table: "ConnectorSessions");

            migrationBuilder.DropColumn(
                name: "BackfillUntil",
                table: "ConnectorSessions");
        }
    }
}
