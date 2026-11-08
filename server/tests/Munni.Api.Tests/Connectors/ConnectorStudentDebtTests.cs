using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Accounts;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// #566: a student debt lands as the loan it is — the balance and the day
/// it was calculated to, what was owed when repayment began, the monthly
/// instalment and its day — where it used to land as a bare figure (€0.00
/// on a debt in its repayment phase) beside a note in one language.
/// </summary>
public class ConnectorStudentDebtTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Sub = "duo-debtor";

    [Fact]
    public async Task A_student_debt_lands_with_its_date_its_starting_size_and_its_instalment()
    {
        using var client = factory.ClientFor(Sub);
        Assert.True((await client.GetAsync("/connectors")).IsSuccessStatusCode);   // provisions the user
        var userId = factory.Read(db => db.Users.Single(u => u.Sub == Sub).Id);
        var debt = JsonNode.Parse("""
            {"id":"sdt_1","external_id":"debt",
             "total":{"value":1243477,"currency":"EUR"},"total_is_derived":true,
             "phase":"repayment","phase_label":"TERUGBETAALPERIODE",
             "interest_rate":2.57,"interest_regime":"SF35","as_of":"2026-08-01",
             "history":[{"kind":"current","amount":{"value":1243477,"currency":"EUR"}},
                        {"kind":"repayment_start","on":"2022-01-01","amount":{"value":2500000,"currency":"EUR"}}],
             "monthly_amount":{"value":23045,"currency":"EUR"},"next_payment_due":"2026-09-01"}
            """)!.AsObject();

        using (var scope = factory.Services.CreateScope())
        {
            var ingest = scope.ServiceProvider.GetRequiredService<ConnectorIngest>();
            await ingest.IngestAsync(userId, "duo", "DUO", "conn-duo", "student_debt", [debt], CancellationToken.None);
        }

        var feedId = ImportIds.PersonalFeedSpaceId(ConnectorIngest.RegistryFeedRef, Sub);
        var row = factory.Read(db => db.EntityRows.Single(r => r.SpaceId == feedId && r.Entity == "account"));
        var data = JsonDocument.Parse(row.DataJson).RootElement;
        Assert.Equal("loan", data.GetProperty("type").GetString());
        Assert.Equal(1_243_477, data.GetProperty("balanceCents").GetInt64());
        Assert.Equal("2026-08-01", data.GetProperty("balanceAsOf").GetString());
        Assert.Equal(2_500_000, data.GetProperty("originalCents").GetInt64());
        Assert.Equal(23_045, data.GetProperty("paymentCents").GetInt64());
        Assert.Equal("month", data.GetProperty("paymentEvery").GetString());
        Assert.Equal(1, data.GetProperty("paymentDay").GetInt32());
        Assert.Equal(2.57m, data.GetProperty("interestPctYear").GetDecimal());
        // the registry's own words only
        Assert.Equal("TERUGBETAALPERIODE · SF35", data.GetProperty("note").GetString());
    }
}
