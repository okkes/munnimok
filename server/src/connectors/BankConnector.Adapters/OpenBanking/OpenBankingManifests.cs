using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// What the two aggregator parties share: the step (a country, then the
/// institution the party lists), the return address the consumer sends as
/// config, the consent-shaped session, the nightly schedule.
/// </summary>
/// <remarks>
/// A consent is reused unattended for its whole life, which is what
/// <c>refreshable</c> means to the validator; it never rotates on its own
/// (<c>rotates_on_use</c> is still true so the material learned at fetch
/// time — the accounts' details — is kept). When it ends, the person
/// consents again: the reauth is not cheap and <c>consent_expired</c> is its
/// trigger.
/// </remarks>
internal static class OpenBankingManifests
{
    public const string CountryField = "country";
    public const string InstitutionField = "institution";
    public const string ReturnUrlConfig = "return_url";

    public const int ConsentDays = 90;
    public const int ConsentTtlSeconds = ConsentDays * 86_400;
    public const int PreferredFetchHourLocal = 3;
    public const int RedirectMinutes = 20;

    /// <summary>NL first: the home market. The rest are the EEA markets both aggregators cover well.</summary>
    public static readonly IReadOnlyList<string> Countries = ["NL", "BE", "DE", "FR", "ES", "IT", "AT", "IE", "GB"];

    public static readonly FieldSpec Country = new()
    {
        Key = CountryField,
        Type = FieldType.Select,
        LabelKey = "connect.field.country",
        Options = Countries,
    };

    public static readonly FieldSpec Institution = new()
    {
        Key = InstitutionField,
        Type = FieldType.Lookup,
        LabelKey = "connect.field.institution",
    };

    /// <summary>The consumer's own page the bank returns to; the challenge's return pattern is this plus a wildcard.</summary>
    public static readonly FieldSpec ReturnUrl = new()
    {
        Key = ReturnUrlConfig,
        Type = FieldType.Text,
        LabelKey = "connect.config.return_url",
        Pattern = "^https?://.+",
    };

    public static readonly AuthStep Bank = new()
    {
        Id = "bank",
        LabelKey = "connect.open_banking.step.bank",
        Fields = [Country, Institution],
    };

    public static AuthSpec Auth() => new()
    {
        Flow = AuthFlow.OauthRedirect,
        Config = [ReturnUrl],
        Steps = [Bank],
        Challenges = [ChallengeType.Redirect],
        Session = new SessionSpec { TtlSeconds = ConsentTtlSeconds, Refreshable = true, RotatesOnUse = true },
        Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["consent_expired", "session_expired"] },
    };

    public static IReadOnlyList<ResourceSpec> Resources(int maxHistoryDays, string notesKey) =>
    [
        BankResources.AccountsSpec(),
        BankResources.TransactionsSpec(
            maxHistoryDays: maxHistoryDays,
            typicalDurationSeconds: 20,
            // an aggregator answers a whole window at once; paging it would
            // only spend the party's daily budget twice
            maxRecordsPerFetch: 20_000,
            notesKey: notesKey),
    ];

    public static ProviderLimits Limits(int maxHistoryDays) => new()
    {
        // once a night; the hour is the bank's, from the IBAN's country
        MinIntervalSeconds = 20 * 3_600,
        Concurrency = 2,
        MaxHistoryDays = maxHistoryDays,
        // late bookings: every fetch re-reads the last three days
        SettlementLagDays = 3,
        PreferredFetchHourLocal = PreferredFetchHourLocal,
    };
}
