using System.Text.Json.Nodes;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Normalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Staging;

/// staging, not storage: rows leave on ack or a hard TTL;
/// neither service may become a honeypot of credentials plus purchase history
public sealed class ResultService(
    ConnectorDbContext db,
    IOptions<ConnectorOptions> options,
    TimeProvider time)
{
    private readonly ConnectorOptions _options = options.Value;

    /// re-emitting updates in place ((session, resource, external_id) is unique): re-runs and settlement-lag widening are free
    /// the id ignores the resource so a transaction's account tie holds: the account under transactions keeps its acc_ id
    /// hence the table is keyed (id, resource)
    public async Task<string> StageAsync(JobRow job, JobResultRequest result, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);
        ArgumentNullException.ThrowIfNull(result);

        var cursor = Ids.New(Ids.Cursor);
        var resource = job.ResourceId ?? "results";
        var staged = Enumerate(result, job.SessionId).ToList();
        if (staged.Count == 0) return cursor;

        var externalIds = staged.Select(s => s.ExternalId).ToList();
        var existing = await db.Results
            .Where(r => r.SessionId == job.SessionId && r.Resource == resource && externalIds.Contains(r.ExternalId))
            .ToDictionaryAsync(r => r.ExternalId, StringComparer.Ordinal, ct);

        var now = time.GetUtcNow();
        var sequence = 0;

        foreach (var record in staged)
        {
            var position = sequence++;

            // assigned, not merged: a later fetch without include=raw must not leave an older pass's raw on the row
            var raw = result.Raw.GetValueOrDefault(record.ExternalId);

            if (existing.TryGetValue(record.ExternalId, out var row))
            {
                // same content still moves onto this cursor so one ack clears the pass
                row.PayloadJson = record.PayloadJson;
                row.RawJson = raw;
                row.ContentHash = record.ContentHash;
                row.Cursor = cursor;
                row.JobId = job.Id;
                row.CreatedAt = now;
                row.Sequence = position;
                continue;
            }

            db.Results.Add(new ResultRow
            {
                Id = record.Id,
                JobId = job.Id,
                SessionId = job.SessionId,
                Resource = resource,
                ExternalId = record.ExternalId,
                PayloadJson = record.PayloadJson,
                RawJson = raw,
                Sequence = position,
                ContentHash = record.ContentHash,
                Cursor = cursor,
                CreatedAt = now,
            });
        }

        await db.SaveChangesAsync(ct);
        return cursor;
    }

    /// raw is grafted only where staged: absent rather than null, which would read as the provider sending nothing
    public async Task<StagedPage> ReadAsync(string jobId, CancellationToken ct)
    {
        var rows = await db.Results
            .AsNoTracking()
            .Where(r => r.JobId == jobId)
            // the adapter's order: CreatedAt is identical across a batch, so ordering by it shuffled purchase history
            .OrderBy(r => r.Sequence)
            .ThenBy(r => r.Id)
            .ToListAsync(ct);

        var data = new JsonArray();
        foreach (var row in rows)
        {
            if (JsonNode.Parse(row.PayloadJson) is not { } node) continue;

            if (node is JsonObject record
                && row.RawJson is { Length: > 0 } raw
                && JsonNode.Parse(raw) is { } parsed)
            {
                record["raw"] = parsed;
            }

            data.Add(node);
        }

        return new StagedPage(data, rows.Count == 0 ? null : rows[^1].Cursor);
    }

    /// acknowledged rows go at once: the connector is a pipe, not a second copy of the consumer's database
    public async Task<int> AckAsync(string sessionId, string resource, string cursor, CancellationToken ct) =>
        await db.Results
            .Where(r => r.SessionId == sessionId && r.Resource == resource && r.Cursor == cursor)
            .ExecuteDeleteAsync(ct);

    /// <summary>Unacknowledged rows die anyway. The caller's silence is not a reason to keep data.</summary>
    public async Task<int> SweepAsync(CancellationToken ct)
    {
        var cutoff = time.GetUtcNow().AddDays(-_options.Timeouts.ResultRetentionDays);
        return await db.Results.Where(r => r.CreatedAt < cutoff).ExecuteDeleteAsync(ct);
    }

    /// ids and hashes are minted here, never by adapters: an adapter inventing its own breaks idempotency and no test shows it
    internal static IEnumerable<StagedRecord> Enumerate(JobResultRequest result, string sessionId)
    {
        foreach (var account in result.Accounts)
        {
            var hash = ContentHash.Of(account);
            var withIds = account with
            {
                Id = Ids.ForRecord(Ids.Account, sessionId, account.ExternalId),
                ContentHash = hash,
            };
            yield return new StagedRecord(withIds.Id, account.ExternalId, hash, ConnectorJson.Serialize(withIds));
        }

        foreach (var transaction in result.Transactions)
        {
            var hash = ContentHash.Of(transaction);
            var withIds = transaction with
            {
                Id = Ids.ForRecord(Ids.Transaction, sessionId, transaction.ExternalId),
                ContentHash = hash,
            };
            yield return new StagedRecord(withIds.Id, transaction.ExternalId, hash, ConnectorJson.Serialize(withIds));
        }

        foreach (var receipt in result.Receipts)
        {
            // reconciliation applied here so the flag is a platform fact, not the adapter's opinion
            var verified = receipt.WithReconciliation();
            var hash = ContentHash.Of(verified);
            var withIds = verified with
            {
                Id = Ids.ForRecord(Ids.Receipt, sessionId, receipt.ExternalId),
                ContentHash = hash,
            };
            yield return new StagedRecord(withIds.Id, receipt.ExternalId, hash, ConnectorJson.Serialize(withIds));
        }

        foreach (var credit in result.Registrations)
        {
            var hash = ContentHash.Of(credit);
            var withIds = credit with
            {
                Id = Ids.ForRecord(Ids.CreditRegistration, sessionId, credit.ExternalId),
                ContentHash = hash,
            };
            yield return new StagedRecord(withIds.Id, credit.ExternalId, hash, ConnectorJson.Serialize(withIds));
        }

        foreach (var debt in result.Debts)
        {
            var hash = ContentHash.Of(debt);
            var withIds = debt with
            {
                Id = Ids.ForRecord(Ids.StudentDebt, sessionId, debt.ExternalId),
                ContentHash = hash,
            };
            yield return new StagedRecord(withIds.Id, debt.ExternalId, hash, ConnectorJson.Serialize(withIds));
        }
    }

    internal readonly record struct StagedRecord(string Id, string ExternalId, string ContentHash, string PayloadJson);
}

public readonly record struct StagedPage(JsonArray Data, string? Cursor);
