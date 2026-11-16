namespace ShopConnector.Adapters.Support;

/// the status mapping lives in Connector.Kit.Adapters.ProviderHttp (the bank pack needs it too);
/// only the retail reading stays here
internal static class RetailHttp
{
    /// statuses a defended endpoint returns when refusing us; 502 and 504 because an edge that tarpits
    /// reports an upstream failure
    public static readonly IReadOnlySet<int> RetailBlockStatuses = new HashSet<int> { 403, 502, 504 };
}
