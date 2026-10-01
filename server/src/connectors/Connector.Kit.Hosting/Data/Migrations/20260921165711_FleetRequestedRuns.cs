using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class FleetRequestedRuns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "FleetOnly",
                table: "sessions",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "FleetOnly",
                table: "jobs",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FleetOnly",
                table: "sessions");

            migrationBuilder.DropColumn(
                name: "FleetOnly",
                table: "jobs");
        }
    }
}
