using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Kit.Exploring;

// the operator's explore run (#441 L3): a browser on a fleet agent at an address the operator typed, driven through the
// lab's live view; hidden from consumer catalogues, refused on every door but the lab's. Public hosts only: the fleet is
// on the household's network, so 10.0.0.1 or localhost would be the operator's browser inside the NAS
public static class ExploreProvider
{
    public const string Id = "explore";

    public const string UrlField = "url";

    public const string Done = "done";

    /// <summary>How long one live view lasts before the operator has to say "more".</summary>
    public const int WindowMinutes = 30;

    public const int MaxUrlLength = 2_048;

    public const string PromptKey = "lab.explore.drive";

    public static ProviderManifest Manifest { get; } = new()
    {
        Id = Id,
        Name = "Explore a site",
        Kind = ProviderKind.Lab,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
        UnattendedFetch = false,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.None,
        OperatorOnly = true,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.ChallengeResponse,
            Steps =
            [
                new AuthStep
                {
                    Id = "start",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = UrlField,
                            Type = FieldType.Text,
                            Required = true,
                            Pattern = "^https?://[^/\\s]+",
                            LabelKey = "lab.explore.url",
                        },
                    ],
                },
            ],
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec { TtlSeconds = 86_400, Refreshable = false, RotatesOnUse = false },
        },
        Resources = [],
    };

    // the manifest and nothing that runs: every explore job is leased by a fleet agent carrying the real adapter.
    // run inline, the control plane says it cannot
    public static IProviderAdapter ManifestOnly { get; } = new ManifestOnlyAdapter();

    public static bool IsNavigable(string? raw, out Uri uri)
    {
        uri = null!;
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > MaxUrlLength) return false;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme is not ("http" or "https")) return false;
        if (!string.IsNullOrEmpty(parsed.UserInfo)) return false;
        if (!IsPublicHost(parsed)) return false;

        uri = parsed;
        return true;
    }

    public static bool IsPublicHost(Uri uri)
    {
        ArgumentNullException.ThrowIfNull(uri);

        var host = uri.Host;
        if (string.IsNullOrEmpty(host)) return false;

        if (uri.HostNameType is UriHostNameType.IPv4 or UriHostNameType.IPv6)
        {
            return IPAddress.TryParse(host.Trim('[', ']'), out var ip) && IsPublicAddress(ip);
        }

        if (uri.HostNameType != UriHostNameType.Dns) return false;

        var lower = host.ToLowerInvariant();
        if (lower == "localhost" || !lower.Contains('.', StringComparison.Ordinal)) return false;

        return !(lower.EndsWith(".local", StringComparison.Ordinal)
                 || lower.EndsWith(".localhost", StringComparison.Ordinal)
                 || lower.EndsWith(".internal", StringComparison.Ordinal)
                 || lower.EndsWith(".lan", StringComparison.Ordinal)
                 || lower.EndsWith(".home", StringComparison.Ordinal)
                 || lower.EndsWith(".home.arpa", StringComparison.Ordinal));
    }

    private static bool IsPublicAddress(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();

        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any)) return false;

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            return !(b[0] == 10
                     || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                     || (b[0] == 192 && b[1] == 168)
                     || (b[0] == 169 && b[1] == 254)
                     || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)
                     || b[0] == 0
                     || b[0] >= 224);
        }

        return !(ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast || ip.IsIPv6UniqueLocal);
    }

    private sealed class ManifestOnlyAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => Manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) => throw Refusal();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw Refusal();

        private static ConnectorException Refusal() =>
            ConnectorException.Unsupported("an explore run happens on a fleet agent, never on the control plane");
    }
}
