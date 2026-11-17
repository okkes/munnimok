using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Connector.Kit.Hosting.Data;

/// the context dotnet ef migrations builds against; never used at run time, never connects
/// Npgsql only: a migration carries one provider's SQL; Sqlite tests use EnsureCreated
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<ConnectorDbContext>
{
    public ConnectorDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<ConnectorDbContext>()
            // a shape, not a destination: scaffolding reads the model and provider, never connects
#pragma warning disable S2068 // a design-time connection string for scaffolding; it never connects
            .UseNpgsql("Host=localhost;Database=connector_design;Username=design;Password=design")
#pragma warning restore S2068
            .Options);
}
