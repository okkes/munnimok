namespace Munni.Api.Connectors;

// remembered per account so that when the bank stops reporting it (booked under a new reference, or cancelled)
// the mirror is tombstoned instead of left as money that never happened (§15)
public class ConnectorPendingTx
{
    public required string AccountRefId { get; set; }

    /// <summary>The feed's transaction entity id (<c>ImportIds.TransactionId(iban, "pending:" + reference)</c>).</summary>
    public required string EntityId { get; set; }
}
