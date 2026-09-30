namespace ShopConnector.Adapters.Support;

/// <summary>
/// The status mapping itself lives in <see cref="Connector.Kit.Adapters.ProviderHttp"/>
/// now (the bank pack's aggregators need it as much as the shops); what stays
/// here is the one reading that is retail-specific.
/// </summary>
internal static class RetailHttp
{
    /// <summary>
    /// Statuses a defended retail endpoint returns when it is refusing us
    /// rather than failing. 502 and 504 belong here because an edge that
    /// tarpits a request reports it as an upstream failure.
    /// </summary>
    public static readonly IReadOnlySet<int> RetailBlockStatuses = new HashSet<int> { 403, 502, 504 };
}
