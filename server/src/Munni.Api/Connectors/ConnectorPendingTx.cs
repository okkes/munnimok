namespace Munni.Api.Connectors;

/// <summary>
/// A pending transaction a bank party reported and the relay mirrored into
/// the feed (§15): remembered per account so that when the bank stops
/// reporting it — booked under a new reference, or cancelled — the mirror is
/// tombstoned rather than left as money that never happened.
/// </summary>
public class ConnectorPendingTx
{
    /// <summary>The <see cref="ConnectorAccountRef.Id"/> the row belongs to.</summary>
    public required string AccountRefId { get; set; }

    /// <summary>The feed's transaction entity id (<c>ImportIds.TransactionId(iban, "pending:" + reference)</c>).</summary>
    public required string EntityId { get; set; }
}
