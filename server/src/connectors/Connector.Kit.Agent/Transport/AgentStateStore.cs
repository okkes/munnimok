using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Transport;

/// one entry per connector, so an agent enrolls once: the one-time code would need a human per recreate
/// keyed by control plane, not connection name: a token belongs to one connector, a changed address re-enrolls
/// reads the old single-object format so running agents keep their enrollment
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

    /// unreadable or corrupt counts as not enrolled: the agent can re-enroll, and refusing to boot helps nobody
    public AgentEnrollment? Load(string controlPlane)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(controlPlane);

        var stored = Read();
        if (stored.Count == 0) return null;

        var mine = stored.FirstOrDefault(entry => Same(entry.ControlPlane, controlPlane));
        if (mine is not null) return mine;

        // named: the usual cause is an agent pointed at a new address
        _logger.LogWarning(
            "agent state at {Path} holds enrollments for {Stored} and none for {Configured}; " +
            "this connector needs a fresh enrollment",
            _path,
            string.Join(", ", stored.Select(entry => entry.ControlPlane)),
            controlPlane);

        return null;
    }

    /// read and write are one locked operation: two connectors enrolling at once on first start is the ordinary case
    public void Save(AgentEnrollment enrollment)
    {
        ArgumentNullException.ThrowIfNull(enrollment);

        lock (_writeLock)
        {
            var kept = Read().Where(entry => !Same(entry.ControlPlane, enrollment.ControlPlane));
            Write([.. kept, enrollment]);
        }
    }

    /// clears only this connector's entry: a revoke is per connector, and DUO has no pooled fleet to fall back on
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

    /// the old format is a bare AgentEnrollment (agent_id at the top); the new one is an object with connections
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

        OwnerOnlyFile.Restrict(temp, _logger);

        File.Move(temp, _path, overwrite: true);
    }

    private static bool Same(string? left, string? right) =>
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}

internal sealed record AgentStateFile
{
    [JsonPropertyName("connections")]
    public IReadOnlyList<AgentEnrollment> Connections { get; init; } = [];
}
