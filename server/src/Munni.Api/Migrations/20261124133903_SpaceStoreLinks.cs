using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class SpaceStoreLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SpaceStoreLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SpaceId = table.Column<string>(type: "text", nullable: false),
                    FeedSpaceId = table.Column<string>(type: "text", nullable: false),
                    AttachedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SpaceStoreLinks", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SpaceStoreLinks_FeedSpaceId",
                table: "SpaceStoreLinks",
                column: "FeedSpaceId");

            migrationBuilder.CreateIndex(
                name: "IX_SpaceStoreLinks_SpaceId_FeedSpaceId",
                table: "SpaceStoreLinks",
                columns: new[] { "SpaceId", "FeedSpaceId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SpaceStoreLinks");
        }
    }
}
