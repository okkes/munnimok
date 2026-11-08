using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class SpaceNotifications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // #549: the device switch was the only choice so far — a person with a registered device had every
            // space's notifications, which stays so …
            migrationBuilder.AddColumn<bool>(
                name: "Notify",
                table: "SpaceMembers",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            // … and a person without one had them off everywhere: that choice carries over to each of their
            // spaces, so switching one space on later turns on that space alone
            migrationBuilder.Sql("""
                UPDATE "SpaceMembers" SET "Notify" = FALSE
                WHERE NOT EXISTS (SELECT 1 FROM "PushSubscriptions" p WHERE p."UserId" = "SpaceMembers"."UserId");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Notify",
                table: "SpaceMembers");
        }
    }
}
