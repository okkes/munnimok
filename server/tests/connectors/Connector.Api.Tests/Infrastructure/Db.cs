using Connector.Kit.Hosting.Data;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Api.Tests.Infrastructure;

// only for invariants with no wire surface by design: an endpoint whose only caller is a test is the worse trade
internal static class Db
{
    public static T Read<T>(ShopApiFactory factory, Func<ConnectorDbContext, T> read)
    {
        ArgumentNullException.ThrowIfNull(factory);
        ArgumentNullException.ThrowIfNull(read);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        return read(db);
    }

    // a state the API alone cannot reach, e.g. an uncollected bundle (the delivery path clears it on read)
    public static void Write(ShopApiFactory factory, Action<ConnectorDbContext> write)
    {
        ArgumentNullException.ThrowIfNull(factory);
        ArgumentNullException.ThrowIfNull(write);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();

        write(db);
        db.SaveChanges();
    }

    public static int StagedRows(ShopApiFactory factory, string sessionId) =>
        Read(factory, db => db.Results.Count(r => r.SessionId == sessionId));

    public static JobRow JobForSubject(ShopApiFactory factory, string subject) =>
        Read(factory, db =>
        {
            var sessionId = db.Sessions.Where(s => s.Subject == subject).Select(s => s.Id).Single();
            return db.Jobs
                .Where(j => j.SessionId == sessionId)
                .OrderByDescending(j => j.CreatedAt)
                .ThenByDescending(j => j.Id)
                .First();
        });

    public static JobRow LatestJob(ShopApiFactory factory, string sessionId) =>
        Read(factory, db => db.Jobs
            .Where(j => j.SessionId == sessionId)
            .OrderByDescending(j => j.CreatedAt)
            .ThenByDescending(j => j.Id)
            .First());
}
