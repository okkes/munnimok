namespace Munni.Api.Connectors;

/// <summary>
/// Which munni feed a connector's bank account landed in. The connector
/// mints an account id per session and names it on every transaction; the
/// transactions of a later fetch — or of a job collected after the sync
/// that started it — need that id turned back into the feed and the account
/// row the accounts pass created. Ids and references only.
/// </summary>
public class ConnectorAccountRef
{
    /// <summary>The connector's account record id (<c>acc_…</c>).</summary>
    public required string Id { get; set; }

    public Guid UserId { get; set; }

    public required string Provider { get; set; }

    /// <summary>The provider's own id for the account.</summary>
    public required string ExternalId { get; set; }

    /// <summary>The normalised IBAN, or <c>CONN:{provider}:{external id}</c> for a card or wallet without one.</summary>
    public required string AccountRef { get; set; }

    /// <summary>The feed space the account's raw rows go to.</summary>
    public required string FeedSpaceId { get; set; }

    /// <summary>The account row's id inside that feed.</summary>
    public required string AccountEntityId { get; set; }

    public required string Currency { get; set; }

    public DateTimeOffset SeenAt { get; set; }

    /// <summary>The connection that last listed this account (§15): the one whose complete fetch settles its pending rows.</summary>
    public string? ConnectionId { get; set; }

    /// <summary>
    /// The person deleted this account's feed while the consent still reaches
    /// other accounts (§15): the consent lives on for those, and this account
    /// is left where the party lists it — no feed, no rows — until the person
    /// connects it again.
    /// </summary>
    public bool Excluded { get; set; }
}
