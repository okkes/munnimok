using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Munni.Api.Migrations
{
    /// <inheritdoc />
    public partial class ConnectionSync : Migration
    {
        // store sync became connection sync: renames, never drop/create —
        // the rows are ciphertext nobody can re-encrypt for the user
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameTable(
                name: "StoreConnCiphers",
                newName: "ConnectionCiphers");

            migrationBuilder.RenameTable(
                name: "StoreSyncDevices",
                newName: "ConnectionSyncDevices");

            migrationBuilder.RenameColumn(
                name: "Store",
                table: "ConnectionCiphers",
                newName: "ConnectionId");

            migrationBuilder.RenameIndex(
                name: "IX_StoreConnCiphers_UserId_Store",
                newName: "IX_ConnectionCiphers_UserId_ConnectionId",
                table: "ConnectionCiphers");

            migrationBuilder.RenameIndex(
                name: "IX_StoreSyncDevices_UserId_DeviceId",
                newName: "IX_ConnectionSyncDevices_UserId_DeviceId",
                table: "ConnectionSyncDevices");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameIndex(
                name: "IX_ConnectionSyncDevices_UserId_DeviceId",
                newName: "IX_StoreSyncDevices_UserId_DeviceId",
                table: "ConnectionSyncDevices");

            migrationBuilder.RenameIndex(
                name: "IX_ConnectionCiphers_UserId_ConnectionId",
                newName: "IX_StoreConnCiphers_UserId_Store",
                table: "ConnectionCiphers");

            migrationBuilder.RenameColumn(
                name: "ConnectionId",
                table: "ConnectionCiphers",
                newName: "Store");

            migrationBuilder.RenameTable(
                name: "ConnectionSyncDevices",
                newName: "StoreSyncDevices");

            migrationBuilder.RenameTable(
                name: "ConnectionCiphers",
                newName: "StoreConnCiphers");
        }
    }
}
