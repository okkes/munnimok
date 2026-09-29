using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Connectors;

/// <summary>
/// Opt-in E2EE sync of connector credential bundles. The server is DUMB
/// STORAGE plus a tiny approval handshake: it keeps device public keys,
/// per-device wrapped copies of the user's Connection Sync Key, and the
/// AES-GCM ciphertext of one connection's credential bundle. No plaintext,
/// no server-side crypto — the server cannot read any of it, which is the
/// whole point.
/// </summary>
public sealed record RegisterDeviceRequest(string DeviceId, string PublicJwk, string Name);
public sealed record WrapRequest(string WrappedCsk);
public sealed record ConnectionCipherRequest(string Cipher);
public sealed record ConnectionSyncDeviceDto(string DeviceId, string PublicJwk, string Name, bool HasWrap, DateTimeOffset CreatedAt);

public static class ConnectionSyncEndpoints
{
    public static void MapConnectionSync(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/me/connection-sync").RequireAuthorization();
        MapDevices(group);
        MapConnections(group);
    }

    private static void MapDevices(RouteGroupBuilder group)
    {
        // announce this device (idempotent — reinstall reuses the id)
        group.MapPost("/devices", RegisterDevice).WithValidation<RegisterDeviceRequest>();

        // every device of mine + whether it can already decrypt
        group.MapGet("/devices", async (AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var devices = await db.ConnectionSyncDevices.Where(d => d.UserId == me).OrderBy(d => d.CreatedAt).ToListAsync();
            return Results.Ok(devices.Select(d => new ConnectionSyncDeviceDto(d.DeviceId, d.PublicJwk, d.Name, d.WrappedCsk != null, d.CreatedAt)));
        });

        // approval: an enrolled device publishes the CSK wrapped to another
        group.MapPost("/devices/{deviceId}/wrap", async (string deviceId, WrapRequest request, AppDbContext db, HttpContext http) =>
        {
            if (request.WrappedCsk.Length is 0 or > 4096) return Results.BadRequest();
            var me = http.GetUserId();
            var device = await db.ConnectionSyncDevices.FirstOrDefaultAsync(d => d.UserId == me && d.DeviceId == deviceId);
            if (device is null) return Results.NotFound();
            device.WrappedCsk = request.WrappedCsk;
            await db.SaveChangesAsync();
            return Results.Ok();
        }).WithValidation<WrapRequest>();

        // my wrap (the new device polls this after asking for approval)
        group.MapGet("/devices/{deviceId}/wrap", async (string deviceId, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var device = await db.ConnectionSyncDevices.FirstOrDefaultAsync(d => d.UserId == me && d.DeviceId == deviceId);
            return device?.WrappedCsk is null ? Results.NoContent() : Results.Ok(new { wrappedCsk = device.WrappedCsk });
        });

        // revocation: the device loses its wrap AND its key row
        group.MapDelete("/devices/{deviceId}", async (string deviceId, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            db.ConnectionSyncDevices.RemoveRange(db.ConnectionSyncDevices.Where(d => d.UserId == me && d.DeviceId == deviceId));
            await db.SaveChangesAsync();
            return Results.Ok();
        });

    }

    private static async Task<IResult> RegisterDevice(RegisterDeviceRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var existing = await db.ConnectionSyncDevices.FirstOrDefaultAsync(d => d.UserId == me && d.DeviceId == request.DeviceId);
        if (existing is null)
        {
            db.ConnectionSyncDevices.Add(new ConnectionSyncDevice
            {
                Id = Guid.NewGuid(),
                UserId = me,
                DeviceId = request.DeviceId,
                PublicJwk = request.PublicJwk,
                Name = request.Name,
                CreatedAt = DateTimeOffset.UtcNow,
            });
        }
        else if (existing.PublicJwk != request.PublicJwk)
        {
            // fresh install minted a new keypair: the old wrap is dead
            existing.PublicJwk = request.PublicJwk;
            existing.Name = request.Name;
            existing.WrappedCsk = null;
        }
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    private static void MapConnections(RouteGroupBuilder group)
    {
        // one bundle ciphertext per connection, keyed by the relay's stable
        // connection id — the same shape the relay's own bodies must carry
        group.MapPut("/connections/{connectionId}", async (string connectionId, ConnectionCipherRequest request, AppDbContext db, HttpContext http) =>
        {
            if (!ConnectionIds.IsValid(connectionId) || request.Cipher.Length is 0 or > 16384) return Results.BadRequest();
            var me = http.GetUserId();
            var row = await db.ConnectionCiphers.FirstOrDefaultAsync(c => c.UserId == me && c.ConnectionId == connectionId);
            if (row is null)
            {
                db.ConnectionCiphers.Add(new ConnectionCipher
                {
                    Id = Guid.NewGuid(),
                    UserId = me,
                    ConnectionId = connectionId,
                    Cipher = request.Cipher,
                    UpdatedAt = DateTimeOffset.UtcNow,
                });
            }
            else
            {
                row.Cipher = request.Cipher;
                row.UpdatedAt = DateTimeOffset.UtcNow;
            }
            await db.SaveChangesAsync();
            return Results.Ok();
        }).WithValidation<ConnectionCipherRequest>();

        group.MapGet("/connections", async (AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var rows = await db.ConnectionCiphers.Where(c => c.UserId == me).ToListAsync();
            return Results.Ok(rows.Select(r => new { connectionId = r.ConnectionId, cipher = r.Cipher, updatedAt = r.UpdatedAt }));
        });

        group.MapDelete("/connections/{connectionId}", async (string connectionId, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            db.ConnectionCiphers.RemoveRange(db.ConnectionCiphers.Where(c => c.UserId == me && c.ConnectionId == connectionId));
            await db.SaveChangesAsync();
            return Results.Ok();
        });

        // the global OFF switch: every ciphertext, wrap and key is erased
        group.MapDelete("", async (AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            db.ConnectionCiphers.RemoveRange(db.ConnectionCiphers.Where(c => c.UserId == me));
            db.ConnectionSyncDevices.RemoveRange(db.ConnectionSyncDevices.Where(d => d.UserId == me));
            await db.SaveChangesAsync();
            return Results.Ok();
        });
    }
}
