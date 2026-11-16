using System.Security.Cryptography;
using System.Text;

namespace Munni.Api.Accounts;

/// ids the server's ingests and the apps agree on (client twin: apps/web/src/domain/feedIds.ts), so a re-fetch,
/// a statement import and a reconnect all land on existing rows
public static class ImportIds
{
    private static readonly Guid Namespace = Guid.Parse("5f3c9a70-0d3e-4e0f-9a57-6d2b3a1c8e42");

    public static string AccountId(string iban) => V5($"acct:{Normalize(iban)}").ToString();
    /// #311: the bank's OWN row when a statement import already owns the canonical id;
    /// separate accounts until the user merges them
    public static string BankAccountId(string iban) => V5($"acct:{Normalize(iban)}:bank").ToString();
    public static string TransactionId(string iban, string reference) => V5($"tx:{Normalize(iban)}:{reference}").ToString();
    /// <summary>sync-space id of a bank account's feed (matches client feedIds.ts)</summary>
    public static string FeedSpaceId(string iban) => V5($"feed:{Normalize(iban)}").ToString();
    /// a PERSONAL feed: the owner's subject in the seed, so deterministic for their reconnects, unguessable for others;
    /// the store feed is STORES, the connector registry REG, an IBAN-less card or wallet its CONN: reference
    public static string PersonalFeedSpaceId(string accountRef, string sub) => V5($"feed:{Normalize(accountRef)}:{sub}").ToString();
    /// <summary>per-space overlay row id for a raw transaction (matches client feedIds.ts)</summary>
    public static string TxMetaId(string spaceId, string txId) => V5($"meta:{spaceId}:{txId}").ToString();
    /// <summary>attachment mirror row id, one per account per space (matches client feedIds.ts)</summary>
    public static string AccountLinkId(string spaceId, string feedId) => V5($"link:{spaceId}:{feedId}").ToString();
    /// <summary>deterministic op ids so server-side ingests are idempotent</summary>
    public static string OpId(string seed) => V5($"op:{seed}").ToString();

    public static string Normalize(string iban) => iban.Replace(" ", "").ToUpperInvariant();

    private static Guid V5(string name)
    {
        var namespaceBytes = Namespace.ToByteArray();
        SwapByteOrder(namespaceBytes);
        var nameBytes = Encoding.UTF8.GetBytes(name);
        // SHA-1 is what RFC 4122 mandates for name-based v5 UUIDs — this is
        // deterministic id derivation, not a security hash
        var hash = SHA1.HashData([.. namespaceBytes, .. nameBytes]); // NOSONAR(S4790) RFC 4122 v5 name-based uuid, no secret involved

        var guid = new byte[16];
        Array.Copy(hash, guid, 16);
        guid[6] = (byte)((guid[6] & 0x0F) | 0x50);
        guid[8] = (byte)((guid[8] & 0x3F) | 0x80);
        SwapByteOrder(guid);
        return new Guid(guid);
    }

    private static void SwapByteOrder(byte[] guid)
    {
        void Swap(int a, int b) => (guid[a], guid[b]) = (guid[b], guid[a]);
        Swap(0, 3);
        Swap(1, 2);
        Swap(4, 5);
        Swap(6, 7);
    }
}
