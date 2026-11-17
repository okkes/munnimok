using System.Text.RegularExpressions;

namespace Connector.Kit.Agent;

// a machine may hold several connections; a code still admits one machine to one connector (each connector signs its own)
// not a user's provider connection (ASN login, DUO registration: a session in the control plane): the link to a CONNECTOR
public sealed partial class ConnectorConnection
{
    // used when configuration names none: the single-connector deployment, given by the top-level ControlPlaneBaseUrl
    public const string DefaultName = "default";

    // becomes a profile sub-root and an HTTP-client name; the pattern blocks a traversal like ../.. from a edited compose file
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")]
    private static partial Regex SafeNamePattern { get; }

    // shown in logs, the profile directory and errors: use the name the operator already has for the connector
    public string Name { get; set; } = DefaultName;

    public Uri? ControlPlaneBaseUrl { get; set; }

    // one per connector, never shared: a code is signed with the minting connector's key and names its subject
    // ignored once enrolled
    public string? EnrollmentCode { get; set; }

    // per connection: two connectors on one LAN can be issued by different internal authorities
    public string? ControlPlaneCaPath { get; set; }

    // true only for the connection synthesized from the top-level settings: an upgrade guarantee, volumes stay at /profiles
    // filing them under /profiles/default would orphan signed-in browsers; a list entry gets /profiles/<name>
    internal bool OwnsTheRoot { get; init; }

    // trailing slash so relative agent paths resolve under the address instead of replacing its last segment
    public Uri RequireBaseAddress()
    {
        var url = ControlPlaneBaseUrl
                  ?? throw new InvalidOperationException($"connection '{Name}' has no ControlPlaneBaseUrl");

        return url.AbsoluteUri.EndsWith(Path.AltDirectorySeparatorChar)
            ? url
            : new Uri(url.AbsoluteUri + Path.AltDirectorySeparatorChar);
    }

    public string ProfileRootUnder(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        return OwnsTheRoot ? root : Path.Combine(root, Name);
    }

    internal IEnumerable<string> Problems()
    {
        if (string.IsNullOrWhiteSpace(Name))
        {
            yield return "a connection needs a Name (ConnectorAgent:Connections:<n>:Name)";
        }
        else if (!SafeNamePattern.IsMatch(Name))
        {
            yield return $"connection name '{Name}' must be 1-32 letters, digits, '-' or '_' and start with a " +
                         "letter or a digit: it becomes a directory under the profile root";
        }

        if (ControlPlaneBaseUrl is null)
        {
            yield return $"connection '{Name}' has no ControlPlaneBaseUrl; an agent with nowhere to call is an " +
                         "agent that enrolls nowhere and leases nothing";
        }
        else if (!ControlPlaneBaseUrl.IsAbsoluteUri)
        {
            yield return $"connection '{Name}' has a ControlPlaneBaseUrl that is not absolute";
        }

        // checked here: at client build a missing CA file would surface in enrollment as "could not reach the control plane"
        if (!string.IsNullOrWhiteSpace(ControlPlaneCaPath) && !File.Exists(ControlPlaneCaPath))
        {
            yield return $"connection '{Name}' trusts a certificate authority at '{ControlPlaneCaPath}', and " +
                         "there is no file there; mount it, or drop the setting if the connector's certificate " +
                         "is publicly trusted";
        }
    }
}
