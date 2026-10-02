using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class JobFound : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Found",
                table: "jobs",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Found",
                table: "jobs");
        }
    }
}
