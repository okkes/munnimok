namespace Munni.Api.Connectors;

// turns a connector's per-session account id back into the feed and account row the accounts pass created;
// ids and references only
public class ConnectorAccountRef
{
    public required string Id { get; set; }

    public Guid UserId { get; set; }

    public required string Provider { get; set; }

    public required string ExternalId { get; set; }

    /// <summary>The normalised IBAN, or <c>CONN:{provider}:{external id}</c> for a card or wallet without one.</summary>
    public required string AccountRef { get; set; }

    public required string FeedSpaceId { get; set; }

    public required string AccountEntityId { get; set; }

    public required string Currency { get; set; }

    public DateTimeOffset SeenAt { get; set; }

    /// <summary>The connection that last listed this account (§15): the one whose complete fetch settles its pending rows.</summary>
    public string? ConnectionId { get; set; }

    // the party's identity for the account across consents (#491): a new consent's card or wallet is filed
    // under the ref an earlier same-identity consent carries
    public string? Identity { get; set; }

    // the person deleted this account's feed while the consent still reaches other accounts (§15):
    // it stays listed by the party, with no feed and no rows, until connected again
    public bool Excluded { get; set; }
}
