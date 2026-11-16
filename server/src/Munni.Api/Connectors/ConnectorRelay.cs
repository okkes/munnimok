using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

public sealed class ConnectorRelay(
    AppDbContext db,
    ConnectorClient client,
    SubjectMinter minter,
    ConnectorEventBridge bridge,
    ConnectorBudget budget,
    ConnectorCatalogue catalogue,
    TimeProvider time)
{
    public AppDbContext Db { get; } = db;

    public ConnectorClient Client { get; } = client;

    public ConnectorCatalogue Catalogue { get; } = catalogue;

    public SubjectMinter Minter { get; } = minter;

    public ConnectorEventBridge Bridge { get; } = bridge;

    public ConnectorBudget Budget { get; } = budget;

    public TimeProvider Time { get; } = time;

    public string SubjectOf(HttpContext http) => Minter.For(http.GetUserId());

    /// <summary>The caller's lab subject (#441): the operator's own runs, apart from the person's app connections.</summary>
    public string LabSubjectOf(HttpContext http) => Minter.ForLab(http.GetUserId());
}
