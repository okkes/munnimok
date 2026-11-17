using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    public partial class SpaceNotifications : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // #549: a person with a registered device had every space's notifications: that stays (default on)
            migrationBuilder.AddColumn<bool>(
                name: "Notify",
                table: "SpaceMembers",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            // a person without one had them off everywhere: that carries over to each space,
            // so switching one on later turns on that space alone
            migrationBuilder.Sql("""
                UPDATE "SpaceMembers" SET "Notify" = FALSE
                WHERE NOT EXISTS (SELECT 1 FROM "PushSubscriptions" p WHERE p."UserId" = "SpaceMembers"."UserId");
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Notify",
                table: "SpaceMembers");
        }
    }
}
