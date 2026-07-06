using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.GoCardless;

public sealed record CreateRequisitionRequest(string SpaceId, string InstitutionId, string RedirectUrl);
public sealed record CreateRequisitionResponse(string Reference, string Link);
public sealed record CompleteResponse(string Status, int LinkedAccounts, int ImportedTransactions);

public static class GcEndpoints
{
    public static void MapGoCardless(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/gocardless").RequireAuthorization();

        // institution list, cached: it changes rarely and GC rate-limits
        group.MapGet("/institutions", async (string country, IGoCardlessApi gc, IMemoryCache cache) =>
        {
            var list = await cache.GetOrCreateAsync($"gc-institutions-{country}", async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(24);
                return await gc.GetInstitutionsAsync(country);
            });
            return Results.Ok(list);
        });

        group.MapPost("/requisitions", async (CreateRequisitionRequest request, IGoCardlessApi gc, AppDbContext db, HttpContext http) =>
        {
            var userId = http.GetUserId();
            if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == request.SpaceId && m.UserId == userId))
                return Results.Forbid();

            var reference = Guid.NewGuid();
            var created = await gc.CreateRequisitionAsync(request.InstitutionId, request.RedirectUrl, reference.ToString());
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = reference,
                UserId = userId,
                SpaceId = request.SpaceId,
                InstitutionId = request.InstitutionId,
                RequisitionId = created.Id,
                Status = "created",
            });
            await db.SaveChangesAsync();
            return Results.Ok(new CreateRequisitionResponse(reference.ToString(), created.Link));
        });

        // called by the app after the bank redirects back
        group.MapPost("/requisitions/{reference:guid}/complete", async (Guid reference, IGoCardlessApi gc, AppDbContext db, HttpContext http) =>
        {
            var userId = http.GetUserId();
            var requisition = await db.GcRequisitions.FindAsync(reference);
            if (requisition is null || requisition.UserId != userId) return Results.NotFound();

            var status = await gc.GetRequisitionAsync(requisition.RequisitionId);
            if (status.Status != "LN") return Results.Ok(new CompleteResponse(status.Status, 0, 0));

            var space = await db.Spaces.FindAsync(requisition.SpaceId);
            if (space is null) return Results.NotFound();

            var ingest = new GcIngest(db);
            var linkedCount = 0;
            var imported = 0;
            foreach (var gcAccountId in status.Accounts)
            {
                var details = await gc.GetAccountDetailsAsync(gcAccountId);
                if (details.Iban is null) continue;

                var linked = await db.GcLinkedAccounts.FindAsync(gcAccountId);
                if (linked is null)
                {
                    linked = new GcLinkedAccount
                    {
                        GcAccountId = gcAccountId,
                        SpaceId = requisition.SpaceId,
                        AccountEntityId = ImportIds.AccountId(details.Iban),
                        Iban = ImportIds.Normalize(details.Iban),
                        Currency = details.Currency ?? "EUR",
                        RequisitionId = requisition.Id,
                    };
                    db.GcLinkedAccounts.Add(linked);
                }

                var balances = await gc.GetBalancesAsync(gcAccountId);
                var transactions = await gc.GetTransactionsAsync(gcAccountId, DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-90)));
                imported += await ingest.IngestAccountAsync(space, linked, details, balances, transactions);
                linked.LastFetchAt = DateTimeOffset.UtcNow;
                linkedCount++;
            }

            requisition.Status = "linked";
            await db.SaveChangesAsync();
            return Results.Ok(new CompleteResponse(status.Status, linkedCount, imported));
        });

        // connection status for the UI (next scheduled fetch, expiry handling)
        group.MapGet("/connections", async (AppDbContext db, HttpContext http) =>
        {
            var userId = http.GetUserId();
            var spaceIds = await db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId).ToListAsync();
            var connections = await db.GcLinkedAccounts
                .Where(a => spaceIds.Contains(a.SpaceId))
                .Select(a => new { a.GcAccountId, a.SpaceId, a.AccountEntityId, a.Iban, a.LastFetchAt })
                .ToListAsync();
            return Results.Ok(connections);
        });
    }
}
