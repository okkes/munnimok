using System.Text.Json.Serialization;

namespace Connector.Kit.Normalization;

/// <summary>
/// One schema for every provider. Provider-shaped output is not an option:
/// the whole value of a connector is that a caller never learns which
/// provider a record came from.
/// </summary>
public abstract record NormalizedRecord
{
    /// <summary>Opaque, prefixed, minted by the control plane.</summary>
    public required string Id { get; init; }

    /// <summary>The provider's own id. Unique per session; drives dedupe.</summary>
    [JsonPropertyName("external_id")]
    public required string ExternalId { get; init; }

    /// <summary>
    /// Stable hash of the meaningful content. With
    /// <c>(session_id, external_id)</c> uniqueness this gives idempotency
    /// for free: a re-run never duplicates and a caller may safely retry.
    /// </summary>
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

    [JsonPropertyName("booked_at")]
    public required DateOnly BookedAt { get; init; }

    [JsonPropertyName("value_at")]
    public DateOnly? ValueAt { get; init; }

    public required Money Amount { get; init; }

    public Counterparty? Counterparty { get; init; }

    public string? Description { get; init; }

    public TransactionKind Kind { get; init; } = TransactionKind.Other;

    /// <summary>
    /// The account balance after this transaction, where the provider states
    /// one. A redundant fact, and therefore a free integrity check - see
    /// <see cref="BalanceChain"/>.
    /// </summary>
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

    /// <summary>
    /// With a real offset, never a bare date: a near-midnight purchase
    /// otherwise matches the wrong day on the consumer's side.
    /// </summary>
    [JsonPropertyName("purchased_at")]
    public required DateTimeOffset PurchasedAt { get; init; }

    public required Money Total { get; init; }

    public ReceiptPayment? Payment { get; init; }

    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    /// <summary>
    /// False when the items and discounts do not sum to the stated total.
    /// The record is still emitted - with a warning rather than silently
    /// dropped - so the consumer can decide what to do with it.
    ///
    /// Also false when <see cref="TotalIsDerived"/> is true, because there was
    /// no stated total to check against and a check that was never made must
    /// not read as one that passed.
    /// </summary>
    public bool Reconciled { get; init; } = true;

    /// <summary>
    /// True when <see cref="Total"/> is this connector's own sum of the lines
    /// rather than a number the provider stated.
    /// </summary>
    /// <remarks>
    /// bol.com is the case: its order API carries a unit price per line and no
    /// order total anywhere. Summing the lines is the only total available, and
    /// reconciling that sum against the lines it came from would be comparing a
    /// number with itself - it can never fail, so it can never mean anything.
    /// <para>
    /// It is a separate field rather than a third state on
    /// <see cref="Reconciled"/> because the two say different things and a
    /// consumer needs both: "these lines do not add up to what the shop said"
    /// is a discrepancy worth showing a user, while "nobody stated a total" is
    /// a fact about the provider. Collapsing them would make the first
    /// unactionable.
    /// </para>
    /// </remarks>
    [JsonPropertyName("total_is_derived")]
    public bool TotalIsDerived { get; init; }

    /// <summary>
    /// The provider's own documents for this purchase - an invoice PDF and
    /// nothing else, so far.
    ///
    /// A LIST rather than a field, because an order is not one invoice. Amazon
    /// issues one per shipment: of ten consecutive orders on a real account,
    /// most had a single invoice, one had two and one had four. A single
    /// <c>invoice</c> property would have looked right on eight of them and
    /// silently dropped three documents on the other two.
    /// <para>
    /// Empty unless the caller asked for it - see
    /// <see cref="Jobs.ResourceRequest.WantsInvoice"/>. These are hundreds of
    /// kilobytes apiece.
    /// </para>
    /// </summary>
    public IReadOnlyList<ReceiptDocument> Documents { get; init; } = [];
}

/// <summary>
/// The closed vocabulary for <see cref="ReceiptDocument.Kind"/>.
///
/// Closed on purpose. A consumer decides what to DO with a document from this
/// value - show it, file it, send it to an accountant - and a provider free to
/// invent its own strings would push that decision back onto knowing which
/// provider answered, which is the one thing this platform exists to prevent.
/// </summary>
public static class ReceiptDocumentKinds
{
    /// <summary>A tax invoice: the document a business would file.</summary>
    public const string Invoice = "invoice";

    public static IReadOnlyList<string> All { get; } = [Invoice];
}

/// <summary>
/// A file the provider issued, carried whole.
///
/// Everything here except the bytes exists so the consumer never has to guess
/// what it is holding. A base64 blob on its own is something a caller must
/// sniff, name and convert before a user can open it; with a media type and a
/// filename beside it, the same blob is one <c>data:</c> URL away from a
/// download the browser handles itself. That difference is the whole reason
/// this is a record and not a string.
/// </summary>
public sealed record ReceiptDocument
{
    /// <summary>
    /// What the document IS, from a fixed vocabulary - currently
    /// <c>invoice</c> alone. A provider-specific string would push the
    /// consumer back into knowing which provider it was talking to, which is
    /// the one thing this platform exists to avoid.
    /// </summary>
    public required string Kind { get; init; }

    /// <summary>
    /// The real one, read off the response rather than assumed from the file
    /// extension. A provider that answers a challenge page to a document URL
    /// sends <c>text/html</c> with a name ending in <c>.pdf</c>, and a
    /// consumer that trusted the name would hand somebody a broken download.
    /// </summary>
    [JsonPropertyName("media_type")]
    public required string MediaType { get; init; }

    /// <summary>
    /// What the provider called it, when it says - Amazon labels split
    /// shipments <c>Factuur 1</c>, <c>Factuur 2</c>. Null when there is
    /// nothing to say, never an invented "Invoice 1 of 2": the numbering is
    /// the provider's and inventing one would be a guess at the shipment it
    /// belongs to.
    /// </summary>
    public string? Name { get; init; }

    /// <summary>Suggested filename, safe to save as.</summary>
    public required string Filename { get; init; }

    /// <summary>
    /// The decoded length, not the base64 length. What a consumer showing
    /// "2.1 MB" needs, and what it would otherwise have to decode to learn.
    /// </summary>
    [JsonPropertyName("size_bytes")]
    public required int SizeBytes { get; init; }

    /// <summary>
    /// The document itself, base64. Named for its encoding so nobody has to
    /// discover it: <c>data:{media_type};base64,{content_base64}</c> is a
    /// working link with no decoding step at all.
    /// </summary>
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

    /// <summary>
    /// Matching on amount and date alone is ambiguous - two identical
    /// purchases on one day are common. The payment tail is what
    /// disambiguates them, so null must be explicit rather than omitted:
    /// the consumer needs to know matching will be weaker.
    /// </summary>
    [JsonPropertyName("card_last4")]
    public string? CardLast4 { get; init; }

    [JsonPropertyName("iban_tail")]
    public string? IbanTail { get; init; }
}

/// <summary>
/// What a line on a receipt actually is.
///
/// A receipt is not a list of products: it is products, plus the charges and
/// credits a merchant adds around them - delivery, deposit, a coupon. The
/// consumer needs to tell those apart to show a sensible breakdown, and the
/// platform needs to count them all to reconcile against the stated total.
///
/// The total itself is unaffected by any of this. It stays the merchant's own
/// stated figure, because that is the number a bank transaction is matched
/// against, and a total we recomputed from lines would drift from the one the
/// user was actually charged.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<ReceiptLineKind>))]
public enum ReceiptLineKind
{
    /// <summary>Something bought. The default, and the only kind most lines are.</summary>
    Product,

    /// <summary>Delivery, service, bag, packaging - a charge that is not a good.</summary>
    Fee,

    /// <summary>Statiegeld and friends: refundable, and a real part of what was paid.</summary>
    Deposit,

    /// <summary>A negative line: coupon, loyalty discount, staff discount.</summary>
    Discount,

    /// <summary>Rounding, a correction, a merchant adjustment.</summary>
    Adjustment,

    /// <summary>
    /// DERIVED, not merchant data: the gap between the stated total and
    /// everything itemised. Emitted only when a merchant charges something it
    /// does not itemise, so a breakdown still adds up to what was paid.
    ///
    /// Labelled rather than folded into a <see cref="Fee"/> on purpose - we do
    /// not know what it was, and guessing a name for money is how a receipt
    /// stops being evidence.
    /// </summary>
    Unattributed,
}

public sealed record ReceiptItem
{
    public required string Name { get; init; }

    /// <summary>
    /// Defaults to <see cref="ReceiptLineKind.Product"/>, so an adapter that
    /// says nothing produces the same receipts it always did.
    /// </summary>
    public ReceiptLineKind Kind { get; init; } = ReceiptLineKind.Product;

    public decimal? Quantity { get; init; }

    [JsonPropertyName("unit_price")]
    public Money? UnitPrice { get; init; }

    public required Money Total { get; init; }

    /// <summary>
    /// Negative. Without discount lines a receipt's items do not sum to its
    /// total, which breaks reconciliation and misleads the consumer.
    /// </summary>
    public ReceiptDiscount? Discount { get; init; }
}

public sealed record ReceiptDiscount
{
    public required Money Amount { get; init; }

    public string? Label { get; init; }
}

/// <summary>
/// Whether a registered credit is still running.
///
/// Two states because the registry states two. A consumer showing "you owe
/// this" needs to know which of these it is looking at, and inferring it from
/// an end date that may be absent is how a settled debt reappears as a live
/// one.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<CreditStatus>))]
public enum CreditStatus
{
    /// <summary>Lopend. Still outstanding.</summary>
    Running,

    /// <summary>Beeindigd. Repaid or otherwise closed.</summary>
    Ended,

    /// <summary>The registry said something this connector does not recognise.</summary>
    Unknown,
}

/// <summary>
/// The shape of a credit, as a registry classifies it.
/// </summary>
/// <remarks>
/// Kept as an enum rather than the registry's own words because the words are
/// Dutch and the classification is not: an instalment loan is an instalment
/// loan in any language, and a consumer should not have to match on
/// "Aflopend krediet" to find one.
/// </remarks>
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

    /// <summary>Registered, but under a label this connector does not map.</summary>
    Other,
}

/// <summary>
/// One credit exactly as a registry states it.
///
/// Deliberately NOT a <see cref="Transaction"/>. A registration is a standing
/// position rather than an event: it has no moment it happened at, its amount
/// is what is registered rather than what moved, and it can sit unchanged for
/// years. Forcing it into the transaction shape would make every consumer
/// invent a booking date the registry never stated.
/// </summary>
public sealed record CreditRegistration : NormalizedRecord
{
    /// <summary>
    /// Who registered it - the lender, as the registry names them. Verbatim:
    /// "Odido Netherlands B.V." is how the user will recognise a phone
    /// contract they forgot was credit at all.
    /// </summary>
    public required string Creditor { get; init; }

    public required CreditKind Kind { get; init; }

    /// <summary>
    /// The registry's own words for <see cref="Kind"/>, kept beside the mapped
    /// value. A label this connector does not recognise still reaches the user
    /// intact instead of arriving as "other" and nothing else.
    /// </summary>
    [JsonPropertyName("kind_label")]
    public string? KindLabel { get; init; }

    /// <summary>
    /// The registered amount. For an instalment credit this is what was
    /// borrowed, not what is left - which is the single most misread number in
    /// a credit register, and the reason it is named plainly here.
    /// </summary>
    public required Money Amount { get; init; }

    public required CreditStatus Status { get; init; }

    /// <summary>When the credit was registered, where the registry states it.</summary>
    [JsonPropertyName("started_on")]
    public DateOnly? StartedOn { get; init; }

    /// <summary>
    /// When it ended, or the date it is due to. Null on a running credit that
    /// states no end, which is normal for revolving credit.
    /// </summary>
    [JsonPropertyName("ends_on")]
    public DateOnly? EndsOn { get; init; }

    /// <summary>
    /// The monthly instalment, where stated. Null rather than derived: a
    /// number computed from a term and a total would look identical to one the
    /// registry gave us, and only one of them is true.
    /// </summary>
    [JsonPropertyName("monthly_amount")]
    public Money? MonthlyAmount { get; init; }

    /// <summary>
    /// An arrears marker, verbatim - BKR's A-codes and the like.
    /// </summary>
    /// <remarks>
    /// Never interpreted here. What an A2 means for somebody's mortgage
    /// application is not a connector's judgement to make, and a connector
    /// that softened or summarised it would be hiding the single most
    /// consequential thing in the record.
    /// </remarks>
    [JsonPropertyName("arrears_code")]
    public string? ArrearsCode { get; init; }
}

/// <summary>
/// Where a student debt is in its life. A balance means something different in
/// each of these, so a consumer that showed one number without this would be
/// telling somebody still studying that they owe money today.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtPhase>))]
public enum StudentDebtPhase
{
    /// <summary>Opbouwfase. Still borrowing; nothing is due yet.</summary>
    Accruing,

    /// <summary>Aanloopfase. Study is over, repayment has not started.</summary>
    GracePeriod,

    /// <summary>Terugbetaalperiode. Monthly repayments are running.</summary>
    Repaying,

    /// <summary>
    /// The provider stated more than one phase at once and this connector
    /// will not choose between them.
    /// </summary>
    /// <remarks>
    /// Not a phase anybody is in - a statement about the answer. Somebody
    /// repaying a student loan while drawing lifelong-learning credit is in
    /// two at once, and the amounts DUO publishes are siblings that carry no
    /// key back to the debt they belong to. Picking the first, or the
    /// "biggest", would put a confident single word on a position this
    /// connector cannot actually resolve.
    /// </remarks>
    Mixed,

    /// <summary>The provider said something this connector does not recognise.</summary>
    Unknown,
}

/// <summary>
/// What a component of a student debt IS.
/// </summary>
/// <remarks>
/// Mapped rather than passed through for the same reason as
/// <see cref="CreditKind"/>: the words are Dutch and the classification is not.
/// A consumer should not have to match on
/// <c>schuldbedragTeveelOntvangenTegemoetkomingScholier</c> to find out that
/// somebody was overpaid a school allowance.
/// </remarks>
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

    /// <summary>A component under a name this connector does not map.</summary>
    Other,
}

/// <summary>One kind of debt inside a <see cref="StudentDebt"/>.</summary>
public sealed record StudentDebtComponent
{
    public required StudentDebtKind Kind { get; init; }

    /// <summary>
    /// The provider's own name for this component, kept beside the mapped
    /// value so a component this connector does not recognise still reaches
    /// the user as something rather than as <c>other</c> and nothing else.
    /// </summary>
    [JsonPropertyName("source_field")]
    public required string SourceField { get; init; }

    public required Money Amount { get; init; }
}

/// <summary>
/// One interest rate and the window it applies to, exactly as stated.
/// </summary>
public sealed record InterestPeriod
{
    /// <summary>
    /// The repayment regime this rate belongs to - DUO's <c>SF35</c> and the
    /// like. Verbatim: which regime somebody falls under decides how long they
    /// repay for, and it is the word their own letters use.
    /// </summary>
    public required string Regime { get; init; }

    [JsonPropertyName("starts_on")]
    public required DateOnly StartsOn { get; init; }

    [JsonPropertyName("ends_on")]
    public required DateOnly EndsOn { get; init; }

    /// <summary>A percentage: <c>2.57</c> means 2.57%, never 0.0257.</summary>
    public required decimal Rate { get; init; }
}

/// <summary>
/// What a national student-finance body states somebody owes.
///
/// One record for the whole position rather than one per component, because
/// that is what it is: a single debt, under one repayment regime, with one
/// interest rate and one monthly plan, that the provider happens to publish as
/// a handful of sibling amounts. Emitting eight records would invent eight
/// debts, and the seven that are usually zero would drown the one that is not.
/// </summary>
public sealed record StudentDebt : NormalizedRecord
{
    /// <summary>
    /// What is owed in total.
    /// </summary>
    /// <remarks>
    /// Check <see cref="TotalIsDerived"/> before showing this as the
    /// provider's own figure. DUO publishes the components and no total; the
    /// total its portal renders is computed in the browser, from a dossier
    /// this connector refuses to fetch.
    /// </remarks>
    public required Money Total { get; init; }

    /// <summary>
    /// True when <see cref="Total"/> is this connector's own sum of
    /// <see cref="Components"/> rather than a figure the provider stated.
    /// </summary>
    /// <remarks>
    /// The same distinction <see cref="Receipt.TotalIsDerived"/> draws, and it
    /// is here for the same reason: a summed total cannot be reconciled
    /// against the lines it was summed from, so a consumer needs to know it
    /// never was.
    /// </remarks>
    [JsonPropertyName("total_is_derived")]
    public bool TotalIsDerived { get; init; }

    /// <summary>
    /// The breakdown, in the provider's own order, carrying only the
    /// components it stated a non-zero amount for.
    /// </summary>
    /// <remarks>
    /// Zeroes are dropped because they are noise rather than news: a provider
    /// that publishes a fixed set of eight amounts states seven zeroes for
    /// almost everybody, and a breakdown that is seven-eighths "nothing" hides
    /// the line that matters. <see cref="Total"/> is unaffected - adding zero
    /// changes nothing.
    /// </remarks>
    public IReadOnlyList<StudentDebtComponent> Components { get; init; } = [];

    public required StudentDebtPhase Phase { get; init; }

    /// <summary>The provider's own word for <see cref="Phase"/>, verbatim.</summary>
    [JsonPropertyName("phase_label")]
    public string? PhaseLabel { get; init; }

    /// <summary>
    /// The rate in force today, resolved from <see cref="InterestPeriods"/>.
    /// A percentage: <c>2.57</c> means 2.57%.
    /// </summary>
    /// <remarks>
    /// Resolved here rather than left to the consumer because "which of these
    /// windows is now" is a rule, not a lookup, and every consumer would
    /// otherwise implement it - slightly differently. Null when no period
    /// covers today, or when the provider stated several positions whose rates
    /// disagree; the periods are still carried, so nothing is lost.
    /// </remarks>
    [JsonPropertyName("interest_rate")]
    public decimal? InterestRate { get; init; }

    /// <summary>The regime <see cref="InterestRate"/> was read from.</summary>
    [JsonPropertyName("interest_regime")]
    public string? InterestRegime { get; init; }

    /// <summary>
    /// Every rate window the provider stated, past and future.
    /// </summary>
    /// <remarks>
    /// Carried whole rather than reduced to today's rate, because next year's
    /// is a real fact about somebody's debt that they cannot get anywhere else
    /// and would otherwise need a second fetch - and a fetch of this costs a
    /// human a sign-in.
    /// </remarks>
    [JsonPropertyName("interest_periods")]
    public IReadOnlyList<InterestPeriod> InterestPeriods { get; init; } = [];

    /// <summary>
    /// Months of payment holiday left, where the provider states a number.
    /// </summary>
    [JsonPropertyName("payment_holiday_months_remaining")]
    public int? PaymentHolidayMonthsRemaining { get; init; }

    /// <summary>
    /// The day the provider calculated interest up to - what its own screen
    /// prints beside the balance as "rente is berekend tot ...".
    /// </summary>
    /// <remarks>
    /// THIS FIELD DID NOT EXIST, AND ITS ABSENCE WAS ARGUED FOR AT LENGTH. The
    /// argument was that the date lived only inside DUO's 2.5 MB customer
    /// dossier, so a minimal-custody connector could not reach it - and the
    /// evidence for that was two live captures in which no narrow endpoint
    /// carried it.
    /// <para>
    /// It was wrong, and the way it was wrong is worth keeping: those captures
    /// covered the endpoints the account holder's browsing happened to call.
    /// <c>raadplegen/schuldhistorie</c> was never among them because nobody had
    /// opened that page. "Every narrow endpoint was checked" was true of the
    /// endpoints that had been SEEN and was stated as though it were true of
    /// the endpoints that EXIST. A third capture, aimed at the pages nobody had
    /// visited, found it in 5.6 KB.
    /// </para>
    /// <para>
    /// Nullable because a provider may not state one, and null still means
    /// exactly what the old omission meant: nothing here is dated, so do not
    /// show it as current. Never inferred - a date computed from a pattern is
    /// indistinguishable in this record from one the provider published, which
    /// is the whole reason it is carried rather than derived.
    /// </para>
    /// </remarks>
    [JsonPropertyName("as_of")]
    public DateOnly? AsOf { get; init; }

    /// <summary>
    /// How many months of the repayment phase are left, where the provider
    /// states a count.
    /// </summary>
    /// <remarks>
    /// Stated, not computed from a term and a start date. The arithmetic looks
    /// trivial and is not: a repayment phase can be paused, extended, or
    /// re-based, and a number this connector calculated would look identical to
    /// one the provider published.
    /// </remarks>
    [JsonPropertyName("repayment_months_remaining")]
    public int? RepaymentMonthsRemaining { get; init; }

    /// <summary>
    /// Balances the provider has stated at named moments - now, at each year
    /// end, and at the start of a phase.
    /// </summary>
    /// <remarks>
    /// Every one of these is a figure the provider published, never a
    /// reconstruction. That distinction is the point of carrying them: given a
    /// starting balance and a current one, somebody can see what a decade of
    /// repayment actually did, and a consumer no longer has to estimate a
    /// starting figure by reading backwards from a ledger.
    /// </remarks>
    public IReadOnlyList<StudentDebtBalance> History { get; init; } = [];

    /// <summary>
    /// The monthly instalment, where the provider states one for the current
    /// month.
    /// </summary>
    [JsonPropertyName("monthly_amount")]
    public Money? MonthlyAmount { get; init; }

    /// <summary>When that instalment falls due.</summary>
    [JsonPropertyName("next_payment_due")]
    public DateOnly? NextPaymentDue { get; init; }

    /// <summary>
    /// Every movement the provider has booked against the debt - what was
    /// borrowed, what interest was added, what was repaid.
    /// </summary>
    /// <remarks>
    /// EMPTY UNLESS ASKED FOR. On DUO this is the one thing that cannot be had
    /// without reading the customer dossier, so it is opt-in per fetch rather
    /// than something a caller receives by accident - see
    /// <see cref="Jobs.ResourceRequest.WantsLedger"/>.
    /// </remarks>
    public IReadOnlyList<StudentDebtEntry> Ledger { get; init; } = [];

    /// <summary>
    /// Whether the ledger adds up to <see cref="Total"/>.
    /// </summary>
    /// <remarks>
    /// Null when no ledger was fetched - a check that was never made must not
    /// read as one that passed.
    /// <para>
    /// This is a free integrity check of the same kind
    /// <see cref="Receipt.Reconciled"/> is, and it is a strong one: every
    /// movement a provider has ever booked should sum to what is owed now. On
    /// a live account it did, to the cent, across 1223 movements and fifteen
    /// years - and separately for each of the eight debts underneath. A
    /// truncated page of history, a dropped row or a flipped sign all break it.
    /// </para>
    /// <para>
    /// False is not a reason to withhold the record. The figures are still the
    /// provider's; what a consumer learns is that this connector could not
    /// prove them consistent, which is worth showing rather than hiding.
    /// </para>
    /// </remarks>
    [JsonPropertyName("ledger_reconciled")]
    public bool? LedgerReconciled { get; init; }
}

/// <summary>What part of a debt a booked movement touched.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtEntryApplies>))]
public enum StudentDebtEntryApplies
{
    /// <summary>The borrowed sum itself.</summary>
    Principal,

    /// <summary>Interest.</summary>
    Interest,

    /// <summary>Something the provider classes as neither.</summary>
    Other,
}

/// <summary>
/// One movement booked against a student debt.
/// </summary>
/// <remarks>
/// Deliberately NOT a <see cref="Transaction"/>. Nothing here moved between
/// accounts: interest being added to a balance is an event with no counterparty
/// and no account id, and forcing it into the transaction shape would make
/// every consumer invent both.
/// </remarks>
public sealed record StudentDebtEntry
{
    /// <summary>The day the provider booked it.</summary>
    [JsonPropertyName("booked_on")]
    public required DateOnly BookedOn { get; init; }

    /// <summary>
    /// SIGNED, and the sign is the provider's own rather than this connector's
    /// reading of a reason code.
    /// </summary>
    /// <remarks>
    /// Positive increases the debt, negative reduces it. Worth stating because
    /// the alternative was a table mapping nineteen Dutch reason codes to a
    /// direction, built by matching five of them against a screenshot - and
    /// the amounts turned out to carry their own sign, so no such table exists
    /// and none can drift.
    /// </remarks>
    public required Money Amount { get; init; }

    /// <summary>
    /// The provider's own reason code, verbatim - DUO's <c>ONTVANGST</c>,
    /// <c>RENTE</c>, <c>OMZETTING_NAAR_GIFT</c>.
    /// </summary>
    /// <remarks>
    /// Carried rather than translated. The provider publishes its own words
    /// for these in its front-end, not in its API, so any prose here would be
    /// a table copied out of somebody's minified JavaScript and left to rot.
    /// A consumer owns the wording, as it owns every other label on this
    /// platform.
    /// </remarks>
    [JsonPropertyName("source_code")]
    public required string SourceCode { get; init; }

    public StudentDebtEntryApplies Applies { get; init; } = StudentDebtEntryApplies.Other;

    /// <summary>
    /// Which debt it was booked against, in the provider's words - "Lening
    /// HO", "Collegegeldkrediet".
    /// </summary>
    public string? Debt { get; init; }
}

/// <summary>Which moment a stated balance belongs to.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<StudentDebtBalanceKind>))]
public enum StudentDebtBalanceKind
{
    /// <summary>What is owed now.</summary>
    Current,

    /// <summary>What was owed at the close of a calendar year.</summary>
    YearEnd,

    /// <summary>What was owed when repayment began.</summary>
    RepaymentStart,

    /// <summary>What was owed when the grace period before repayment began.</summary>
    GracePeriodStart,

    /// <summary>A moment this connector does not recognise.</summary>
    Unknown,
}

/// <summary>
/// One balance the provider stated, at one moment.
/// </summary>
public sealed record StudentDebtBalance
{
    public required StudentDebtBalanceKind Kind { get; init; }

    /// <summary>The provider's own word for the moment, verbatim.</summary>
    [JsonPropertyName("kind_label")]
    public string? KindLabel { get; init; }

    /// <summary>The calendar year, on a year-end balance.</summary>
    public int? Year { get; init; }

    /// <summary>The day, where the provider dates the moment rather than naming a year.</summary>
    public DateOnly? On { get; init; }

    public required Money Amount { get; init; }

    /// <summary>
    /// How much of <see cref="Amount"/> is accrued interest rather than
    /// borrowed money, where the provider separates them.
    /// </summary>
    [JsonPropertyName("interest_portion")]
    public Money? InterestPortion { get; init; }

    /// <summary>The rate in force at that moment. A percentage: <c>2.57</c> is 2.57%.</summary>
    public decimal? Rate { get; init; }

    /// <summary>
    /// What the balance is FOR, where the provider says - DUO names each grant
    /// and loan separately at the start of a grace period.
    /// </summary>
    public string? Label { get; init; }
}
