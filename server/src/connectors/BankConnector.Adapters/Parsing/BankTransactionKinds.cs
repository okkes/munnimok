using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Parsing;

// its own type: ING states the same code in a CSV column and in its web API's JSON (type.id);
// two tables could classify one row differently
public static class BankTransactionKinds
{
    // UI hint only: an unknown code is Other, not a failed run. Codes and words are ING's (real export, 2026-08-12):
    // codes match across nl/en, words do not; words serve CSVs without a code column (card export).
    // DV stays Other: ING's own "something else" bucket (rows seen: interest, a fee, a card settlement)
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
