using System.Text.RegularExpressions;

namespace Connector.Kit.Agent;

/// <summary>
/// One connector this agent attaches to: where it is, the code that admits
/// this machine to it, and the authority that signs its certificate.
/// </summary>
/// <remarks>
/// <b>An agent process used to serve exactly one of these, and that is why a
/// household ran three containers.</b> The bank, the shopping and the registry
/// connectors are three control planes; each mints its own enrollment code,
/// signs it with its own key, and knows nothing of the other two. Nothing about
/// that changes here - a code still admits one machine to one connector - but
/// the machine is now free to hold several of these at once, which is what the
/// person on the other end was actually asking for: one agent of their own,
/// not one per product we happen to have split the platform into.
/// <para>
/// The word "connection" is overloaded on this platform and it is worth being
/// clear which one this is NOT. A user's connection to a provider - their ASN
/// login, their DUO registration - is a session and lives in the control
/// plane. This is the agent's link to a CONNECTOR, of which there are three in
/// the whole repository.
/// </para>
/// </remarks>
public sealed partial class ConnectorConnection
{
    /// <summary>
    /// What a connection is called when the configuration names none - which
    /// is the whole of the existing single-connector deployment, where the
    /// control plane is given by the top-level
    /// <see cref="ConnectorAgentOptions.ControlPlaneBaseUrl"/> and there is
    /// nothing to tell apart.
    /// </summary>
    public const string DefaultName = "default";

    /// <summary>
    /// A legal directory name and a legal HTTP-client name, because this
    /// becomes both: a profile sub-root on disk and the name the two
    /// control-plane clients are registered under. A name of <c>../..</c>
    /// would otherwise be a directory traversal written by whoever edits the
    /// compose file.
    /// </summary>
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")]
    private static partial Regex SafeNamePattern { get; }

    /// <summary>
    /// Which connector this is, in one word: <c>bank</c>, <c>shop</c>,
    /// <c>registry</c>. It is written down in three places a person can see -
    /// every log line this connection produces, the profile directory it keeps
    /// its browsers in, and the error when something about it is wrong - so it
    /// is worth being the name the operator already uses for the connector.
    /// </summary>
    public string Name { get; set; } = DefaultName;

    /// <summary>The connector's root, e.g. <c>https://ledgerbridge.internal:8392/</c>.</summary>
    public Uri? ControlPlaneBaseUrl { get; set; }

    /// <summary>
    /// The one-time enrollment code for THIS connector. Only needed until this
    /// connection has enrolled; after that the state file carries the identity
    /// and this is ignored.
    /// </summary>
    /// <remarks>
    /// One per connector, never shared: a code is signed with the minting
    /// connector's key and names the subject it was minted for, so the
    /// registry connector cannot read the bank's and would learn nothing from
    /// it if it could.
    /// </remarks>
    public string? EnrollmentCode { get; set; }

    /// <summary>
    /// A PEM certificate authority to trust for this connector, on top of what
    /// the machine already trusts. Per connection because two connectors on
    /// one LAN can perfectly well be issued by two different internal
    /// authorities - see <see cref="ConnectorAgentOptions.ControlPlaneCaPath"/>
    /// for why one is needed at all.
    /// </summary>
    public string? ControlPlaneCaPath { get; set; }

    /// <summary>
    /// Whether this connection owns the shared roots rather than a
    /// sub-directory of them.
    /// </summary>
    /// <remarks>
    /// <b>True only for the connection synthesized from the top-level
    /// settings, and that is an upgrade guarantee rather than a tidiness
    /// preference.</b> Every agent running today is configured that way -
    /// three shipped images, every compose file in <c>deploy/</c> - and its
    /// profiles are on a volume mounted at <c>/profiles</c>. Filing them under
    /// <c>/profiles/default</c> on the next release would leave a signed-in
    /// bank browser sitting in a directory nothing reads, and the account
    /// holder would be asked for the phone, the card and the codes again to
    /// rebuild what was already there.
    /// <para>
    /// A connection that comes from the <c>Connections</c> list gets
    /// <c>/profiles/&lt;name&gt;</c>, which is also how an existing volume
    /// moves across: mount it at the sub-path named after the connection and
    /// nothing was lost.
    /// </para>
    /// </remarks>
    internal bool OwnsTheRoot { get; init; }

    /// <summary>
    /// The base address with a trailing slash, so relative agent paths resolve
    /// instead of silently replacing the last segment.
    /// </summary>
    public Uri RequireBaseAddress()
    {
        var url = ControlPlaneBaseUrl
                  ?? throw new InvalidOperationException($"connection '{Name}' has no ControlPlaneBaseUrl");

        return url.AbsoluteUri.EndsWith('/') ? url : new Uri(url.AbsoluteUri + "/");
    }

    /// <summary>
    /// Where this connection's persistent browser profiles live under the
    /// machine's profile root. See <see cref="OwnsTheRoot"/>.
    /// </summary>
    public string ProfileRootUnder(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        return OwnsTheRoot ? root : Path.Combine(root, Name);
    }

    /// <summary>The problems with this connection, in the operator's words.</summary>
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

        // A CA is read when the first client is built, which is inside the
        // enrollment attempt - so a path that is not there surfaces as "could
        // not reach the control plane", retried for ever, with a certificate
        // nowhere in the sentence. Checked here instead, where the answer is
        // the path and the connector it belongs to.
        if (!string.IsNullOrWhiteSpace(ControlPlaneCaPath) && !File.Exists(ControlPlaneCaPath))
        {
            yield return $"connection '{Name}' trusts a certificate authority at '{ControlPlaneCaPath}', and " +
                         "there is no file there; mount it, or drop the setting if the connector's certificate " +
                         "is publicly trusted";
        }
    }
}
