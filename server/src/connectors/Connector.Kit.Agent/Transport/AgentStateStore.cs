using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Transport;

/// <summary>
/// The enrollment state file: one entry per connector this machine serves.
///
/// It exists so that an agent enrolls exactly once per connector: an
/// enrollment code is one-time and HMAC-signed, so a restart that re-enrolled
/// would leave a BYO user unable to bring their agent back without asking for
/// a new code - a human, at a keyboard, for every recreate.
/// </summary>
/// <remarks>
/// <b>Keyed by CONTROL PLANE rather than by connection name</b>, because that
/// is what a token actually belongs to: it is scoped to one connector's
/// <c>/agent/v1/*</c> and is meaningless anywhere else. Two consequences are
/// worth having. Renaming a connection in a compose file is free - the
/// enrollment is found by the address, not the label - and pointing one at a
/// different connector still forces a fresh enrollment rather than sending one
/// service's token to another, which is the rule this file has always had.
/// <para>
/// <b>It reads the old single-object format</b>, which is what every running
/// agent has on its state volume today. Losing it would cost each of them a
/// fresh one-time code and somebody present to redeem it, which is precisely
/// the thing this file exists to prevent, so the upgrade is silent and the
/// entry keeps the control plane it was issued by.
/// </para>
/// </remarks>
public sealed class AgentStateStore
{
    private readonly string _path;
    private readonly ILogger<AgentStateStore> _logger;
    private readonly Lock _writeLock = new();

    public AgentStateStore(string path, ILogger<AgentStateStore> logger)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentNullException.ThrowIfNull(logger);

        _path = Path.GetFullPath(path);
        _logger = logger;
    }

    public string FilePath => _path;

    /// <summary>
    /// Returns the enrollment this control plane issued, or null when there is
    /// none, the file is unreadable, or the only enrollments in it belong to
    /// other connectors. A corrupt file is treated as "not enrolled" rather
    /// than fatal - the agent can always re-enroll with a fresh code, and
    /// refusing to boot helps nobody.
    /// </summary>
    public AgentEnrollment? Load(string controlPlane)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(controlPlane);

        var stored = Read();
        if (stored.Count == 0) return null;

        var mine = stored.FirstOrDefault(entry => Same(entry.ControlPlane, controlPlane));
        if (mine is not null) return mine;

        // Named, because the commonest way to see this is an agent pointed at
        // a new address - a moved connector, a renamed host - and "we have a
        // token, but for somewhere else" is the sentence that explains why it
        // is asking for a code again.
        _logger.LogWarning(
            "agent state at {Path} holds enrollments for {Stored} and none for {Configured}; " +
            "this connector needs a fresh enrollment",
            _path,
            string.Join(", ", stored.Select(entry => entry.ControlPlane)),
            controlPlane);

        return null;
    }

    /// <summary>
    /// Records this connector's enrollment, leaving every other connector's
    /// alone. The whole file is rewritten, so the read and the write are one
    /// locked operation: two connectors enrolling at the same moment on a
    /// first start is the ordinary case, not a rare one.
    /// </summary>
    public void Save(AgentEnrollment enrollment)
    {
        ArgumentNullException.ThrowIfNull(enrollment);

        lock (_writeLock)
        {
            var kept = Read().Where(entry => !Same(entry.ControlPlane, enrollment.ControlPlane));
            Write([.. kept, enrollment]);
        }
    }

    /// <summary>
    /// Forgets this connector's enrollment and nothing else.
    /// </summary>
    /// <remarks>
    /// SURGICAL, because a revoke is one connector's verdict. A bank connector
    /// restored from a backup taken before this agent enrolled answers 401 to
    /// everything; clearing the whole file there would have cost the registry
    /// connector beside it its enrollment too, and DUO has no pooled fleet to
    /// fall back to while somebody mints another code.
    /// </remarks>
    public void Clear(string controlPlane)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(controlPlane);

        lock (_writeLock)
        {
            var kept = Read().Where(entry => !Same(entry.ControlPlane, controlPlane)).ToArray();

            if (kept.Length > 0)
            {
                Write(kept);
                return;
            }

            try
            {
                if (File.Exists(_path)) File.Delete(_path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogError(ex, "could not delete agent state at {Path}; the revoked token is still on disk", _path);
            }
        }
    }

    /// <summary>
    /// Every enrollment on disk, in either format.
    /// </summary>
    /// <remarks>
    /// The old format is a bare <see cref="AgentEnrollment"/> object, which is
    /// what one agent serving one connector wrote for the whole life of the
    /// platform so far. It is told apart by what it has rather than by a
    /// version number: an object with <c>agent_id</c> at the top is one
    /// enrollment, an object with <c>connections</c> is the list.
    /// </remarks>
    private IReadOnlyList<AgentEnrollment> Read()
    {
        if (!File.Exists(_path)) return [];

        try
        {
            var text = File.ReadAllText(_path);

            var state = JsonSerializer.Deserialize<AgentStateFile>(text, AgentJson.Options);
            if (state?.Connections is { Count: > 0 } connections) return [.. connections];

            var single = JsonSerializer.Deserialize<AgentEnrollment>(text, AgentJson.Options);
            if (single is null) return [];

            _logger.LogInformation(
                "agent state at {Path} is the single-connector format; reading it as the enrollment for {ControlPlane}",
                _path, single.ControlPlane);

            return [single];
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "agent state at {Path} is unreadable; treating the agent as unenrolled", _path);
            return [];
        }
    }

    private void Write(IReadOnlyList<AgentEnrollment> connections)
    {
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        // Written whole then moved into place: a torn state file would look
        // like a lost enrollment and burn the user's one-time code.
        var temp = _path + ".tmp";
        File.WriteAllText(
            temp,
            JsonSerializer.Serialize(new AgentStateFile { Connections = connections }, AgentJson.Options));

        // The file holds a bearer token, so it is owner-only where the platform
        // has a notion of that.
        OwnerOnlyFile.Restrict(temp, _logger);

        File.Move(temp, _path, overwrite: true);
    }

    private static bool Same(string? left, string? right) =>
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// The state file as it is written from now on: one enrollment per connector,
/// each carrying the control plane that issued it.
/// </summary>
internal sealed record AgentStateFile
{
    [JsonPropertyName("connections")]
    public IReadOnlyList<AgentEnrollment> Connections { get; init; } = [];
}
