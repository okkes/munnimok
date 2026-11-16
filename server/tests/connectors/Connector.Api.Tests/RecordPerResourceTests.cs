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

// a record id may appear once per resource of a session: a transactions fetch stages the accounts too, same acc_ id
// the primary key was the id alone, so a bank session's second fetch failed; real staging + Sqlite prove key and index agree
[Collection(ShopApiCollection.Name)]
public sealed class RecordPerResourceTests(ShopApiFactory factory)
{
    private const string Accounts = "accounts";
    private const string Transactions = "transactions";

    private const string AccountExternalId = "NL00MOCK0000000001";
    private const string TransactionExternalId = "txn-2026-09-01-0001";

    // a fresh scope each time, as two fetches are: one context would refuse the second entity in its own tracker
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

        var transaction = Db.Read(factory, db => db.Results.AsNoTracking()
            .Where(r => r.SessionId == session && r.Resource == Transactions && r.ExternalId == TransactionExternalId)
            .Select(r => r.PayloadJson)
            .Single());

        using var payload = JsonDocument.Parse(transaction);
        Assert.Equal(accountId, payload.RootElement.GetProperty("account_id").GetString());
    }

    // the repeat moves the rows onto its own cursor, so one ack clears the pass
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

    // the job row is not written: staging reads only its id, session and resource
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

    // states the id the platform would mint anyway, as a bank adapter does: the transaction names it before staging
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
