using System.Text.Json.Serialization;

namespace Connector.Kit.Normalization;

// one schema for every provider: a caller never learns which provider a record came from
public abstract record NormalizedRecord
{
    /// <summary>Opaque, prefixed, minted by the control plane.</summary>
    public required string Id { get; init; }

    /// <summary>The provider's own id. Unique per session; drives dedupe.</summary>
    [JsonPropertyName("external_id")]
    public required string ExternalId { get; init; }

    // stable hash of the meaningful content; with (session_id, external_id) uniqueness a re-run never duplicates
    [JsonPropertyName("content_hash")]
    public string ContentHash { get; init; } = string.Empty;
}

[JsonConverter(typeof(JsonStringEnumConverter<AccountType>))]
public enum AccountType
{
    Current,
    Savings,
    CreditCard,
    Loan,
    Unknown,
}

public sealed record Account : NormalizedRecord
{
    public required AccountType Type { get; init; }

    [JsonPropertyName("display_name")]
    public required string DisplayName { get; init; }

    public string? Iban { get; init; }

    [JsonPropertyName("masked_number")]
    public string? MaskedNumber { get; init; }

    public required string Currency { get; init; }

    public Balance? Balance { get; init; }

    // the institution as the party's lookup lists it (an aggregator institution id), so a client can ask for the same logo;
    // absent where the party is the institution
    public string? Institution { get; init; }

    // the account's identity across consents and sessions (an aggregator identification hash); without it an IBAN-less
    // wallet looked new on every consent (#491)
    public string? Identity { get; init; }
}

public sealed record Balance
{
    public required Money Amount { get; init; }

    [JsonPropertyName("as_of")]
    public required DateTimeOffset AsOf { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<TransactionKind>))]
public enum TransactionKind
{
    CardPayment,
    Transfer,
    DirectDebit,
    Interest,
    Fee,
    Other,
}

public sealed record Transaction : NormalizedRecord
{
    [JsonPropertyName("account_id")]
    public required string AccountId { get; init; }

    // true when the connector built ExternalId from the row's facts: it can move when a fact moves, so reconcile by content
    // (ING card repayments landed twice once the derived id carried the login session)
    [JsonPropertyName("id_is_derived")]
    public bool IdIsDerived { get; init; }

    [JsonPropertyName("booked_at")]
    public required DateOnly BookedAt { get; init; }

    [JsonPropertyName("value_at")]
    public DateOnly? ValueAt { get; init; }

    public required Money Amount { get; init; }

    public Counterparty? Counterparty { get; init; }

    public string? Description { get; init; }

    public TransactionKind Kind { get; init; } = TransactionKind.Other;

    // the balance after this transaction, where stated; redundant, so an integrity check (BalanceChain)
    [JsonPropertyName("resulting_balance")]
    public Money? ResultingBalance { get; init; }
}

public sealed record Counterparty
{
    public string? Name { get; init; }

    public string? Iban { get; init; }
}

public sealed record Receipt : NormalizedRecord
{
    public required Merchant Merchant { get; init; }

    // with a real offset, never a bare date: a near-midnight purchase otherwise matches the wrong day
    [JsonPropertyName("purchased_at")]
    public required DateTimeOffset PurchasedAt { get; init; }

    public required Money Total { get; init; }

    public ReceiptPayment? Payment { get; init; }

    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    // false when items and discounts do not sum to the stated total (still emitted), or when TotalIsDerived:
    // a check never made must not read as passed
    public bool Reconciled { get; init; } = true;

    // true when Total is the connector's own sum of the lines (bol.com's order API states no total); that can never fail.
    // A separate field from Reconciled: "lines do not add up" is a discrepancy to show, "no total stated" a provider fact
    [JsonPropertyName("total_is_derived")]
    public bool TotalIsDerived { get; init; }

    // a LIST: an order is not one invoice (Amazon issues one per shipment; of ten orders one had two, one four).
    // Empty unless requested (ResourceRequest.WantsInvoice): hundreds of KB apiece
    public IReadOnlyList<ReceiptDocument> Documents { get; init; } = [];
}

// closed vocabulary: a consumer decides what to do from Kind, and provider-invented strings would make it know the provider
public static class ReceiptDocumentKinds
{
    /// <summary>A tax invoice: the document a business would file.</summary>
    public const string Invoice = "invoice";

    public static IReadOnlyList<string> All { get; } = [Invoice];
}

// carried whole with media type and filename, so the consumer need not sniff, name or convert it
public sealed record ReceiptDocument
{
    public required string Kind { get; init; }

    // read off the response, not the extension: a challenge page answers text/html under a name ending .pdf
    [JsonPropertyName("media_type")]
    public required string MediaType { get; init; }

    // the provider's label (Amazon: Factuur 1, Factuur 2); null when none, never an invented "Invoice 1 of 2"
    public string? Name { get; init; }

    public required string Filename { get; init; }

    // the decoded length, not the base64 length
    [JsonPropertyName("size_bytes")]
    public required int SizeBytes { get; init; }

    // base64; data:{media_type};base64,{content_base64} is a working link
    [JsonPropertyName("content_base64")]
    public required string ContentBase64 { get; init; }
}

public sealed record Merchant
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    [JsonPropertyName("store_name")]
    public string? StoreName { get; init; }
}

public sealed record ReceiptPayment
{
    /// <summary><c>card</c>, <c>cash</c>, <c>ideal</c>, <c>other</c>.</summary>
    public string? Method { get; init; }

    // amount and date alone are ambiguous (identical purchases on one day); the payment tail disambiguates,
    // so null is explicit: matching is weaker
    [JsonPropertyName("card_last4")]
    public string? CardLast4 { get; init; }

    [JsonPropertyName("iban_tail")]
    public string? IbanTail { get; init; }
}

// a receipt holds products plus the charges and credits around them; the total stays the merchant's stated figure,
// because a bank transaction is matched against it
[JsonConverter(typeof(JsonStringEnumConverter<ReceiptLineKind>))]
public enum ReceiptLineKind
{
    Product,

    Fee,

    /// <summary>Statiegeld and friends: refundable, and a real part of what was paid.</summary>
    Deposit,

    Discount,

    Adjustment,

    // DERIVED, not merchant data: the gap between the stated total and everything itemised;
    // labelled rather than folded into Fee, as the reason is unknown
    Unattributed,
}

public sealed record ReceiptItem
{
    public required string Name { get; init; }

    public ReceiptLineKind Kind { get; init; } = ReceiptLineKind.Product;

    public decimal? Quantity { get; init; }

    [JsonPropertyName("unit_price")]
    public Money? UnitPrice { get; init; }

    public required Money Total { get; init; }

    // negative; without discount lines the items do not sum to the total
    public ReceiptDiscount? Discount { get; init; }
}

public sealed record ReceiptDiscount
{
    public required Money Amount { get; init; }

    public string? Label { get; init; }
}

// two states because the registry states two; inferring from a possibly absent end date makes a settled debt look live
[JsonConverter(typeof(JsonStringEnumConverter<CreditStatus>))]
public enum CreditStatus
{
    /// <summary>Lopend. Still outstanding.</summary>
    Running,

    /// <summary>Beeindigd. Repaid or otherwise closed.</summary>
    Ended,

    Unknown,
}

// an enum, not the registry's Dutch words: the classification is language-independent
[JsonConverter(typeof(JsonStringEnumConverter<CreditKind>))]
public enum CreditKind
{
    /// <summary>Aflopend krediet. Fixed sum, repaid on a schedule.</summary>
    Instalment,

    /// <summary>Doorlopend krediet. A limit you may draw against repeatedly.</summary>
    Revolving,

    /// <summary>Verzendhuiskrediet and friends: pay later for goods.</summary>
    DeferredPayment,

    /// <summary>Hypotheek.</summary>
    Mortgage,

    /// <summary>Leasing.</summary>
    Lease,

    Other,
}

// NOT a Transaction: a registration is a standing position with no event date, so consumers would invent a booking date
public sealed record CreditRegistration : NormalizedRecord
{
    // the lender verbatim as the registry names them
    public required string Creditor { get; init; }

    public required CreditKind Kind { get; init; }

    // the registry's own words, kept beside the mapped value so an unmapped label still reaches the user
    [JsonPropertyName("kind_label")]
    public string? KindLabel { get; init; }

    // for an instalment credit this is what was borrowed, not what is left
    public required Money Amount { get; init; }

    public required CreditStatus Status { get; init; }

    [JsonPropertyName("started_on")]
    public DateOnly? StartedOn { get; init; }

    // null on a running credit that states no end (normal for revolving credit)
    [JsonPropertyName("ends_on")]
    public DateOnly? EndsOn { get; init; }

    // null rather than derived: a computed value would look identical to one the registry gave
    [JsonPropertyName("monthly_amount")]
    public Money? MonthlyAmount { get; init; }

    // an arrears marker verbatim (BKR A-codes); never interpreted here
    [JsonPropertyName("arrears_code")]
    public string? ArrearsCode { get; init; }
}

// a balance means something different in each phase; one number without it tells somebody still studying they owe today
[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtPhase>))]
public enum StudentDebtPhase
{
    /// <summary>Opbouwfase. Still borrowing; nothing is due yet.</summary>
    Accruing,

    /// <summary>Aanloopfase. Study is over, repayment has not started.</summary>
    GracePeriod,

    /// <summary>Terugbetaalperiode. Monthly repayments are running.</summary>
    Repaying,

    // the provider stated several phases at once and its sibling amounts carry no key to their debt, so this connector
    // does not choose
    Mixed,

    Unknown,
}

// mapped, not passed through, as with CreditKind: the provider's field names are Dutch
[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtKind>))]
public enum StudentDebtKind
{
    /// <summary>Studielening. The ordinary borrowed sum.</summary>
    Loan,

    /// <summary>Levenlanglerenkrediet. Borrowing to study outside the grant system.</summary>
    LifelongLearningCredit,

    /// <summary>Prestatiebeurs: a grant that becomes a loan without a diploma.</summary>
    PerformanceGrant,

    /// <summary>Ov-schuld, from a travel product that was not stopped in time.</summary>
    PublicTransport,

    /// <summary>Paid too much study finance, and it is being reclaimed.</summary>
    ExcessStudyFinance,

    /// <summary>Earned over the limit while receiving study finance.</summary>
    ExcessEarnings,

    /// <summary>Drew more lifelong-learning credit than was due.</summary>
    ExcessLifelongLearningCredit,

    /// <summary>Overpaid tegemoetkoming scholieren, the school allowance.</summary>
    ExcessSchoolAllowance,

    Other,
}

public sealed record StudentDebtComponent
{
    public required StudentDebtKind Kind { get; init; }

    // the provider's own name, kept beside the mapped value so an unmapped component still reaches the user
    [JsonPropertyName("source_field")]
    public required string SourceField { get; init; }

    public required Money Amount { get; init; }
}

public sealed record InterestPeriod
{
    // the repayment regime verbatim (DUO SF35): it decides how long somebody repays
    public required string Regime { get; init; }

    [JsonPropertyName("starts_on")]
    public required DateOnly StartsOn { get; init; }

    [JsonPropertyName("ends_on")]
    public required DateOnly EndsOn { get; init; }

    /// <summary>A percentage: <c>2.57</c> means 2.57%, never 0.0257.</summary>
    public required decimal Rate { get; init; }
}

// one record for the whole position, not per component: eight records would invent eight debts, seven usually zero
public sealed record StudentDebt : NormalizedRecord
{
    // DUO publishes components and no total (its portal sums in the browser from a dossier this connector refuses to fetch)
    public required Money Total { get; init; }

    // true when Total is the connector's own sum of Components; a summed total cannot be reconciled against its own lines
    [JsonPropertyName("total_is_derived")]
    public bool TotalIsDerived { get; init; }

    // only components with a non-zero stated amount: a fixed set of eight states seven zeroes for most people;
    // Total is unaffected
    public IReadOnlyList<StudentDebtComponent> Components { get; init; } = [];

    public required StudentDebtPhase Phase { get; init; }

    /// <summary>The provider's own word for <see cref="Phase"/>, verbatim.</summary>
    [JsonPropertyName("phase_label")]
    public string? PhaseLabel { get; init; }

    // the rate in force today, resolved from InterestPeriods (a percentage: 2.57 means 2.57%); null when no period
    // covers today or the stated positions' rates disagree
    [JsonPropertyName("interest_rate")]
    public decimal? InterestRate { get; init; }

    [JsonPropertyName("interest_regime")]
    public string? InterestRegime { get; init; }

    // carried whole, not reduced to today's rate: next year's is a real fact found nowhere else, and a fetch costs a sign-in
    [JsonPropertyName("interest_periods")]
    public IReadOnlyList<InterestPeriod> InterestPeriods { get; init; } = [];

    [JsonPropertyName("payment_holiday_months_remaining")]
    public int? PaymentHolidayMonthsRemaining { get; init; }

    // the day interest was calculated up to; null means nothing here is dated, so do not show it as current; never inferred.
    // Found on raadplegen/schuldhistorie, which earlier captures missed: "every narrow endpoint was checked" held only
    // for the endpoints seen, not the ones that exist
    [JsonPropertyName("as_of")]
    public DateOnly? AsOf { get; init; }

    // stated, not computed from term and start date: a phase can be paused, extended or re-based
    [JsonPropertyName("repayment_months_remaining")]
    public int? RepaymentMonthsRemaining { get; init; }

    // figures the provider published, never reconstructed: now, each year end, the start of a phase
    public IReadOnlyList<StudentDebtBalance> History { get; init; } = [];

    [JsonPropertyName("monthly_amount")]
    public Money? MonthlyAmount { get; init; }

    [JsonPropertyName("next_payment_due")]
    public DateOnly? NextPaymentDue { get; init; }

    // empty unless asked for (ResourceRequest.WantsLedger): on DUO it needs the customer dossier
    public IReadOnlyList<StudentDebtEntry> Ledger { get; init; } = [];

    // null when no ledger was fetched: a check never made must not read as passed. The movements should sum to what is owed;
    // false still carries the record and only says consistency could not be proved
    [JsonPropertyName("ledger_reconciled")]
    public bool? LedgerReconciled { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtEntryApplies>))]
public enum StudentDebtEntryApplies
{
    Principal,

    Interest,

    Other,
}

// NOT a Transaction: interest added to a balance has no counterparty and no account id
public sealed record StudentDebtEntry
{
    [JsonPropertyName("booked_on")]
    public required DateOnly BookedOn { get; init; }

    // SIGNED, the provider's own sign (positive increases the debt); no table mapping Dutch reason codes to a direction exists
    public required Money Amount { get; init; }

    // the provider's reason code verbatim (ONTVANGST, RENTE): its wording lives in its front-end, so the consumer owns labels
    [JsonPropertyName("source_code")]
    public required string SourceCode { get; init; }

    public StudentDebtEntryApplies Applies { get; init; } = StudentDebtEntryApplies.Other;

    public string? Debt { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtBalanceKind>))]
public enum StudentDebtBalanceKind
{
    Current,

    YearEnd,

    RepaymentStart,

    GracePeriodStart,

    Unknown,
}

public sealed record StudentDebtBalance
{
    public required StudentDebtBalanceKind Kind { get; init; }

    [JsonPropertyName("kind_label")]
    public string? KindLabel { get; init; }

    public int? Year { get; init; }

    public DateOnly? On { get; init; }

    public required Money Amount { get; init; }

    [JsonPropertyName("interest_portion")]
    public Money? InterestPortion { get; init; }

    /// <summary>The rate in force at that moment. A percentage: <c>2.57</c> is 2.57%.</summary>
    public decimal? Rate { get; init; }

    public string? Label { get; init; }
}
