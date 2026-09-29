using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

/// <summary>
/// What every relay handler needs, resolved once per request: the
/// database for the bindings, the client to the control plane, the subject
/// minter, the event bridge, the budget and the clock. One parameter in a
/// handler's signature instead of six, and one place that says which
/// collaborators the relay has.
/// </summary>
public sealed class ConnectorRelay(
    AppDbContext db,
    ConnectorClient client,
    SubjectMinter minter,
    ConnectorEventBridge bridge,
    ConnectorBudget budget,
    TimeProvider time)
{
    public AppDbContext Db { get; } = db;

    public ConnectorClient Client { get; } = client;

    public SubjectMinter Minter { get; } = minter;

    public ConnectorEventBridge Bridge { get; } = bridge;

    public ConnectorBudget Budget { get; } = budget;

    public TimeProvider Time { get; } = time;

    /// <summary>The subject the control plane sees for the signed-in user of this request.</summary>
    public string SubjectOf(HttpContext http) => Minter.For(http.GetUserId());
}
