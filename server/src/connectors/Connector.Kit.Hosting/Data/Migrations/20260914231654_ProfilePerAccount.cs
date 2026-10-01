using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class ProfilePerAccount : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_profiles_SessionId",
                table: "profiles");

            migrationBuilder.DropColumn(
                name: "SessionId",
                table: "profiles");

            migrationBuilder.AddColumn<string>(
                name: "Subject",
                table: "profiles",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_profiles_AgentId_ProviderId_Subject",
                table: "profiles",
                columns: new[] { "AgentId", "ProviderId", "Subject" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_profiles_AgentId_ProviderId_Subject",
                table: "profiles");

            migrationBuilder.DropColumn(
                name: "Subject",
                table: "profiles");

            migrationBuilder.AddColumn<string>(
                name: "SessionId",
                table: "profiles",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_profiles_SessionId",
                table: "profiles",
                column: "SessionId");
        }
    }
}
