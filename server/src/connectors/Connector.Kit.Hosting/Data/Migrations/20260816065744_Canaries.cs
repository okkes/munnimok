using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class Canaries : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "canaries",
                columns: table => new
                {
                    ProviderId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Subject = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Bundle = table.Column<string>(type: "text", nullable: false),
                    ResourceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    IntervalMinutes = table.Column<int>(type: "integer", nullable: false),
                    LastRunAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: true),
                    LastJobId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    LastVerdict = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    LastIntact = table.Column<bool>(type: "boolean", nullable: true),
                    CreatedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_canaries", x => x.ProviderId);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "canaries");
        }
    }
}
