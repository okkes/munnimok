using System.Security.Cryptography;

namespace Connector.Kit;

// prefixes keep a job id from being passed where a session id belongs and make a log line self-describing; 128 CSPRNG
// bits, because several endpoints take an id as their only lookup key
public static class Ids
{
    public const string Session = "ses";
    public const string Job = "job";
    public const string Challenge = "chl";
    public const string Agent = "agt";
    public const string PrivateAgentRequest = "par";
    public const string Profile = "prf";
    public const string Ticket = "tkt";
    public const string Account = "acc";
    public const string Transaction = "txn";
    public const string Receipt = "rcp";

    public const string CreditRegistration = "crd";

    public const string StudentDebt = "sdt";
    public const string Cursor = "cur";
    public const string Error = "err";
    public const string Event = "evt";

    public static string New(string prefix) =>
        $"{prefix}_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16))}";

    public static bool Is(string? id, string prefix) =>
        id is not null && id.StartsWith(prefix + "_", StringComparison.Ordinal);

    // deterministic: re-running a fetch gives the same ids for the same upstream data, so with content hashing retries are free
    public static string ForRecord(string prefix, string sessionId, string externalId)
    {
        var digest = SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"{prefix}|{sessionId}|{externalId}"));
        return $"{prefix}_{Convert.ToHexStringLower(digest.AsSpan(0, 16))}";
    }
}
