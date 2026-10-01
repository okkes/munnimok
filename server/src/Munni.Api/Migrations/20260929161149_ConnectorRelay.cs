using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class ConnectorRelay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ConnectorAccountRefs",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    ExternalId = table.Column<string>(type: "text", nullable: false),
                    AccountRef = table.Column<string>(type: "text", nullable: false),
                    FeedSpaceId = table.Column<string>(type: "text", nullable: false),
                    AccountEntityId = table.Column<string>(type: "text", nullable: false),
                    Currency = table.Column<string>(type: "text", nullable: false),
                    SeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConnectorAccountRefs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ConnectorSessions",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    ConnectionId = table.Column<string>(type: "text", nullable: false),
                    State = table.Column<string>(type: "text", nullable: false),
                    Label = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConnectorSessions", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ConnectorAccountRefs_UserId",
                table: "ConnectorAccountRefs",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_ConnectorSessions_UserId",
                table: "ConnectorSessions",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_ConnectorSessions_UserId_Provider_ConnectionId",
                table: "ConnectorSessions",
                columns: new[] { "UserId", "Provider", "ConnectionId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConnectorAccountRefs");

            migrationBuilder.DropTable(
                name: "ConnectorSessions");
        }
    }
}
