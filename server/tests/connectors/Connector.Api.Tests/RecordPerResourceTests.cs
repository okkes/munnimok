using System.Text.Json;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Jobs;
using Connector.Kit.Normalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// A RECORD ID MAY APPEAR ONCE PER RESOURCE OF A SESSION, and the table has
/// to say so.
///
/// <para>
/// A transactions fetch stages the accounts alongside the rows on purpose: a
/// transaction names its account by id, the consumer groups a history by that
/// id, and the tie only holds if the account under <c>transactions</c> carries
/// the same <c>acc_</c> id it carried under <c>accounts</c>. So the id is
/// minted from <c>(session, external_id)</c> and nothing else - and the same
/// record therefore lands under two resources of one session, once each.
/// </para>
///
/// <para>
/// The dedupe and the unique index were both scoped that way, and the primary
/// key was not: it was the id alone. Every bank provider in the fleet re-emits
/// its accounts with its transactions, so the second fetch on any bank session
/// inserted a row the key refused, the fetch failed as <c>internal</c>, and
/// the session ended up expired or its job stuck on the queue. Reproduced on
/// <c>mock-bank-simple</c>, the one provider that exists so this loop can be
/// shown on a laptop.
/// </para>
///
/// <para>
/// Against the real staging service and the real Sqlite host rather than the
/// enumerator alone: the rule under test is the database's, and only a write
/// that reaches it can prove the key agrees with the index beside it.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class RecordPerResourceTests(ShopApiFactory factory)
{
    private const string Accounts = "accounts";
    private const string Transactions = "transactions";

    private const string AccountExternalId = "NL00MOCK0000000001";
    private const string TransactionExternalId = "txn-2026-09-01-0001";

    /// <summary>
    /// THE ACCOUNTS PAGE AND THE TRANSACTIONS PAGE EACH HOLD THE ACCOUNT.
    /// </summary>
    /// <remarks>
    /// Two rows, one id, one per resource - and the transaction beside the
    /// second one points at that same id, which is the whole reason the second
    /// row is allowed to exist. In a fresh scope each time, as two fetches are:
    /// one context would refuse the second entity in its own tracker and never
    /// let the database give its answer.
    /// </remarks>
    [Fact]
    public async Task An_account_re_emitted_with_its_transactions_sits_beside_the_one_the_accounts_page_staged()
    {
        var session = Ids.New(Ids.Session);
        var accountId = Ids.ForRecord(Ids.Account, session, AccountExternalId);

        await StageAsync(session, Accounts, new JobResultRequest { Accounts = [Account(accountId)] });
        await StageAsync(session, Transactions, new JobResultRequest
        {
            Accounts = [Account(accountId)],
            Transactions = [Transaction(session, accountId)],
        });

        Assert.Equal(3, Db.StagedRows(factory, session));

        var copies = Db.Read(factory, db => db.Results.AsNoTracking()
            .Where(r => r.SessionId == session && r.Id == accountId)
            .OrderBy(r => r.Resource)
            .Select(r => r.Resource)
            .ToList());

        Assert.Equal([Accounts, Transactions], copies);

        // The tie itself, read back off the row as the consumer will read it.
        var transaction = Db.Read(factory, db => db.Results.AsNoTracking()
            .Where(r => r.SessionId == session && r.Resource == Transactions && r.ExternalId == TransactionExternalId)
            .Select(r => r.PayloadJson)
            .Single());

        using var payload = JsonDocument.Parse(transaction);
        Assert.Equal(accountId, payload.RootElement.GetProperty("account_id").GetString());
    }

    /// <summary>
    /// AND A REPEAT OF ONE RESOURCE STILL LANDS ON ONE ROW.
    /// </summary>
    /// <remarks>
    /// The per-resource dedupe is what makes a re-run free for the caller, and
    /// it is untouched by the key admitting a second resource: the second
    /// transactions pass updates the rows the first one wrote, moves them onto
    /// its own cursor so one ack clears the pass, and adds nothing.
    /// </remarks>
    [Fact]
    public async Task A_second_transactions_pass_updates_the_rows_the_first_one_wrote()
    {
        var session = Ids.New(Ids.Session);
        var accountId = Ids.ForRecord(Ids.Account, session, AccountExternalId);

        var page = new JobResultRequest
        {
            Accounts = [Account(accountId)],
            Transactions = [Transaction(session, accountId)],
        };

        await StageAsync(session, Accounts, new JobResultRequest { Accounts = [Account(accountId)] });
        await StageAsync(session, Transactions, page);
        var again = await StageAsync(session, Transactions, page);

        Assert.Equal(3, Db.StagedRows(factory, session));

        var cursors = Db.Read(factory, db => db.Results.AsNoTracking()
            .Where(r => r.SessionId == session && r.Resource == Transactions)
            .Select(r => r.Cursor)
            .Distinct()
            .ToList());

        Assert.Equal([again], cursors);
    }

    /// <summary>
    /// One job's output, staged the way <c>JobOutcomeService</c> stages it.
    /// The job is not written down: staging reads its id, its session and its
    /// resource, and nothing about a result row refers back to the jobs table.
    /// </summary>
    private async Task<string> StageAsync(string session, string resource, JobResultRequest result)
    {
        using var scope = factory.Services.CreateScope();
        var results = scope.ServiceProvider.GetRequiredService<ResultService>();

        var job = new JobRow
        {
            Id = Ids.New(Ids.Job),
            SessionId = session,
            ProviderId = "test-ledger",
            Kind = JobKind.Fetch,
            ResourceId = resource,
        };

        return await results.StageAsync(job, result, CancellationToken.None);
    }

    /// <summary>
    /// Stated with the id the platform will mint anyway, as a bank adapter
    /// states it: the transaction below has to name it before staging has
    /// happened, and <c>Enumerate</c> overwrites it with the same value.
    /// </summary>
    private static Account Account(string id) => new()
    {
        Id = id,
        ExternalId = AccountExternalId,
        Type = AccountType.Current,
        DisplayName = "Betaalrekening",
        Currency = "EUR",
    };

    private static Transaction Transaction(string session, string accountId) => new()
    {
        Id = Ids.ForRecord(Ids.Transaction, session, TransactionExternalId),
        ExternalId = TransactionExternalId,
        AccountId = accountId,
        BookedAt = new DateOnly(2026, 9, 1),
        Amount = Money.Eur(-1250),
    };
}
