using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Parsing;

/// <summary>
/// The two-letter mutation code every Dutch bank stamps on a transaction,
/// and what it means.
///
/// Its own type rather than a private method on the CSV reader, because the
/// same bank states the same code through more than one door. ING's export
/// puts <c>BA</c> in a column; ING's own web API puts <c>{"type":{"id":"BA"}}</c>
/// in a JSON payload. Two copies of this table would be two chances for one
/// route to call a purchase a transfer while the other calls it a card
/// payment, on the same account, for the same row.
/// </summary>
public static class BankTransactionKinds
{
    /// <summary>
    /// The kind a code means. It is a UI hint only and never touches an
    /// amount, so an unknown code degrades to
    /// <see cref="TransactionKind.Other"/> rather than failing the run - the
    /// opposite of how an unparseable amount is treated.
    /// </summary>
    /// <remarks>
    /// The codes and both sets of words below are ING's own, read off a real
    /// export of one account in Dutch and in English on 2026-08-12. The codes
    /// are identical between the two; every word is not, which is why the CSV
    /// schema claims the code column first and why both vocabularies are
    /// listed here rather than one.
    /// <para>
    /// The words are here because a CSV can arrive with no code column at
    /// all - ING's credit-card export is one - and then the localised word is
    /// the only thing left to read. A JSON payload always states the code, so
    /// that route never reaches them.
    /// </para>
    /// <para>
    /// <c>DV</c> - Diversen / Various - is deliberately <c>Other</c> rather
    /// than a guess. It is ING's own bucket for "something else", and giving
    /// it a specific kind would invent a fact the bank declined to state. The
    /// capture proves the point: three <c>DV</c> rows on one account were an
    /// interest charge, a monthly fee and a credit-card settlement.
    /// </para>
    /// </remarks>
    public static TransactionKind FromCode(string? code) =>
        LocaleTolerantCsv.Normalize(code) switch
        {
            // Card at a terminal, and cash out of a machine. Both are the card
            // being used, which is what a consumer is grouping by.
            "ba" or "gm" or "betaalautomaat" or "geldautomaat" or "pinnen"
                or "paymentterminal" or "cashmachine"
                or "geldopname" or "withdrawal" or "betaling" or "payment" => TransactionKind.CardPayment,

            // Money moved on instruction - by the account holder online, as a
            // batch, or through iDEAL. Wero rides on ING's iDEAL code.
            "gt" or "ov" or "vz" or "tb" or "id" or "iw" or "st"
                or "overboeking" or "overschrijving" or "transfer" or "onlinebankieren"
                or "onlinebanking" or "verzamelbetaling" or "batchpayment"
                or "ideal" or "idealwero" or "storting" or "deposit" or "ontvangst" => TransactionKind.Transfer,

            "ic" or "incasso" or "directdebit" or "sepadirectdebit" or "debit" => TransactionKind.DirectDebit,

            "re" or "rb" or "rente" or "interest" => TransactionKind.Interest,

            "kn" or "ks" or "kosten" or "fee" or "costs" => TransactionKind.Fee,

            _ => TransactionKind.Other,
        };
}
