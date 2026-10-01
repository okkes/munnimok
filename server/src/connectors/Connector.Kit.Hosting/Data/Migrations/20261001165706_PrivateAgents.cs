using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class PrivateAgents : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "BoundAt",
                table: "agents",
                type: "character varying(28)",
                unicode: false,
                maxLength: 28,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "Hosted",
                table: "agents",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "ResetRequestedAt",
                table: "agents",
                type: "character varying(28)",
                unicode: false,
                maxLength: 28,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "private_agent_requests",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Subject = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    CreatedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false),
                    DecidedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: true),
                    AgentId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_private_agent_requests", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_private_agent_requests_State",
                table: "private_agent_requests",
                column: "State");

            migrationBuilder.CreateIndex(
                name: "IX_private_agent_requests_Subject",
                table: "private_agent_requests",
                column: "Subject");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "private_agent_requests");

            migrationBuilder.DropColumn(
                name: "BoundAt",
                table: "agents");

            migrationBuilder.DropColumn(
                name: "Hosted",
                table: "agents");

            migrationBuilder.DropColumn(
                name: "ResetRequestedAt",
                table: "agents");
        }
    }
}
