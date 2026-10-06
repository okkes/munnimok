using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class JobTracesAndRecord : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "Record",
                table: "jobs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "job_traces",
                columns: table => new
                {
                    JobId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SessionId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ProviderId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Entries = table.Column<int>(type: "integer", nullable: false),
                    Dropped = table.Column<int>(type: "integer", nullable: false),
                    Truncated = table.Column<bool>(type: "boolean", nullable: false),
                    ByteCount = table.Column<int>(type: "integer", nullable: false),
                    Bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                    Digest = table.Column<string>(type: "text", nullable: false),
                    StartedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false),
                    EndedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false),
                    CapturedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false),
                    ExpiresAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_job_traces", x => x.JobId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_job_traces_ExpiresAt",
                table: "job_traces",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_job_traces_ProviderId",
                table: "job_traces",
                column: "ProviderId");

            migrationBuilder.CreateIndex(
                name: "IX_job_traces_SessionId",
                table: "job_traces",
                column: "SessionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "job_traces");

            migrationBuilder.DropColumn(
                name: "Record",
                table: "jobs");
        }
    }
}
