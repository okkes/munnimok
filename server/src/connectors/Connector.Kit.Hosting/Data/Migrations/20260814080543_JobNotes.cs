using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Connector.Kit.Hosting.Data.Migrations
{
    /// <inheritdoc />
    public partial class JobNotes : Migration
    {
        /// <inheritdoc />
        /// <remarks>
        /// The default is "[]" rather than EF's generated "": the column holds
        /// a JSON array and every existing row is about to have one. An empty
        /// string parses as nothing, which the reader tolerates - but a column
        /// whose stored value does not satisfy its own contract is a trap for
        /// whoever queries it next.
        /// </remarks>
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "NotesJson",
                table: "jobs",
                type: "text",
                nullable: false,
                defaultValue: "[]");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "NotesJson",
                table: "jobs");
        }
    }
}
