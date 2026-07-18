using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Munni.Api.Auth;
using Munni.Api.Banking;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.GoCardless;

public sealed record CreateRequisitionRequest(string SpaceId, string InstitutionId, string RedirectUrl, string? AppScheme = null);
public sealed record CreateRequisitionResponse(string Reference, string Link);
public sealed record CompleteResponse(string Status, int LinkedAccounts, int ImportedTransactions, string? AppScheme = null);

public static partial class GcEndpoints
{
    [System.Text.RegularExpressions.GeneratedRegex("^[A-Za-z]{2}$")]
    private static partial System.Text.RegularExpressions.Regex CountryCode();

    public static void MapGoCardless(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/gocardless").RequireAuthorization().WithSafeRouteParams();

        // institution list, cached per active provider: it changes rarely
        // and the vendors rate-limit
        group.MapGet("/institutions", async (string country, BankProviderRegistry registry, AppDbContext db, IMemoryCache cache) =>
        {
            if (!CountryCode().IsMatch(country))
                return Results.BadRequest(new { error = "country must be a 2-letter code" });
            var api = await registry.ActiveAsync(db);
            var list = await cache.GetOrCreateAsync($"institutions-{api.ProviderId}-{country}", async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(24);
                return await api.GetInstitutionsAsync(country);
            });
            return Results.Ok(list);
        });

        group.MapPost("/requisitions", async (CreateRequisitionRequest request, BankProviderRegistry registry, AppDbContext db, HttpContext http) =>
        {
            var userId = http.GetUserId();
            if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == request.SpaceId && m.UserId == userId))
                return Results.Forbid();

            var api = await registry.ActiveAsync(db); // the admin's pick decides NEW consents
            var reference = Guid.NewGuid();
            GcRequisitionCreated created;
            try
            {
                created = await api.CreateRequisitionAsync(request.InstitutionId, request.RedirectUrl, reference.ToString());
            }
            catch (Exception ex)
            {
                // surface WHICH provider failed and why (sans secrets): the
                // admin switched providers and the app only said "failed"
                var detail = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
                return Results.Problem(title: $"{api.ProviderId} requisition failed", detail: detail, statusCode: 502);
            }
            db.GcRequisitions.Add(new GcRequisition
            {
                Id = reference,
                UserId = userId,
                SpaceId = request.SpaceId,
                InstitutionId = request.InstitutionId,
                RequisitionId = created.Id,
                Status = "created",
                Provider = api.ProviderId,
                AppScheme = request.AppScheme,
            });
            await db.SaveChangesAsync();
            return Results.Ok(new CreateRequisitionResponse(reference.ToString(), created.Link));
        }).WithValidation<CreateRequisitionRequest>();

        // called after the bank redirects back. Installed-PWA journeys can
        // detour through the bank's NATIVE app, whose return link opens in
        // a plain browser tab with no app session (user bug report) — so
        // completion is anonymous-capable: the requisition reference is a
        // GUID we minted for exactly this journey, i.e. a capability token.
        // A present session still has to match the requisition's owner.
        group.MapPost("/requisitions/{reference:guid}/complete", CompleteRequisition).AllowAnonymous();

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

    private static async Task<IResult> CompleteRequisition(Guid reference, string? code, BankProviderRegistry registry, AppDbContext db, HttpContext http)
    {
            var userId = http.TryGetUserId();
            var requisition = await db.GcRequisitions.FindAsync(reference);
            if (requisition is null || (userId is not null && requisition.UserId != userId)) return Results.NotFound();

            var gc = registry.For(requisition.Provider);
            var status = await gc.CompleteAuthAsync(requisition.RequisitionId, code);
            // Enable Banking mints its session id at complete time
            if (status.Id != requisition.RequisitionId) requisition.RequisitionId = status.Id;
            if (status.Status != "LN")
            {
                await db.SaveChangesAsync();
                return Results.Ok(new CompleteResponse(status.Status, 0, 0, requisition.AppScheme));
            }

            var space = await db.Spaces.FindAsync(requisition.SpaceId);
            if (space is null) return Results.NotFound();

            var ingest = new GcIngest(db);
            var linkedCount = 0;
            var imported = 0;
            foreach (var gcAccountId in status.Accounts)
            {
                var details = await gc.GetAccountDetailsAsync(gcAccountId);
                // wallet-style accounts (PayPal…) carry no IBAN — a
                // deterministic per-account reference keeps the whole feed
                // machinery working (user bug: the consent completed fine
                // but the connection never appeared)
                var accountRef = details.Iban ?? $"GC:{gcAccountId}";

                var linked = await db.GcLinkedAccounts.FindAsync(gcAccountId);
                if (linked is null)
                {
                    linked = new GcLinkedAccount
                    {
                        GcAccountId = gcAccountId,
                        SpaceId = requisition.SpaceId,
                        AccountEntityId = ImportIds.AccountId(accountRef),
                        Iban = ImportIds.Normalize(accountRef),
                        Currency = details.Currency ?? "EUR",
                        RequisitionId = requisition.Id,
                        Provider = requisition.Provider,
                    };
                    db.GcLinkedAccounts.Add(linked);
                }

                var balances = await gc.GetBalancesAsync(gcAccountId);
                var page = await gc.GetTransactionsAsync(gcAccountId, DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-90)));
                imported += await ingest.IngestAccountAsync(space, linked, details, balances, page.Booked, page.Pending);
                linked.LastFetchAt = DateTimeOffset.UtcNow;
                linked.HistoryBackfilledAt = DateTimeOffset.UtcNow; // this fetch was the full window
                linkedCount++;
            }

            requisition.Status = "linked";
            await db.SaveChangesAsync();
            return Results.Ok(new CompleteResponse(status.Status, linkedCount, imported, requisition.AppScheme));
    }
}
