using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class JobAgent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AgentId",
                table: "jobs",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_jobs_AgentId",
                table: "jobs",
                column: "AgentId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_jobs_AgentId",
                table: "jobs");

            migrationBuilder.DropColumn(
                name: "AgentId",
                table: "jobs");
        }
    }
}
