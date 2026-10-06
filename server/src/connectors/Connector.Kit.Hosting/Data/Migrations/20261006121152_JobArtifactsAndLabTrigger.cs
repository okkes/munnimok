using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class JobArtifactsAndLabTrigger : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "job_artifacts",
                columns: table => new
                {
                    JobId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SessionId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ProviderId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Screenshot = table.Column<byte[]>(type: "bytea", nullable: true),
                    DomDigest = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    CapturedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false),
                    ExpiresAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: false),
                    SharedAt = table.Column<string>(type: "character varying(28)", unicode: false, maxLength: 28, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_job_artifacts", x => x.JobId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_jobs_ProviderId_CreatedAt",
                table: "jobs",
                columns: new[] { "ProviderId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_job_artifacts_ExpiresAt",
                table: "job_artifacts",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_job_artifacts_ProviderId_Status",
                table: "job_artifacts",
                columns: new[] { "ProviderId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_job_artifacts_SessionId",
                table: "job_artifacts",
                column: "SessionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "job_artifacts");

            migrationBuilder.DropIndex(
                name: "IX_jobs_ProviderId_CreatedAt",
                table: "jobs");
        }
    }
}
