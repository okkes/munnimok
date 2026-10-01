using Connector.Kit.Agent.Transport;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Transport;

/// <summary>
/// The state file, now that one machine enrolls with several connectors.
///
/// <para>
/// What is in it is the only thing standing between a user and a fresh
/// one-time code: an enrollment code is single-use and HMAC-signed, so an
/// agent that loses its entry comes back as a stranger and needs a human at a
/// keyboard to mint another. It holds one entry per connector now, keyed by
/// the control plane that issued it - which is what a bearer token belongs to.
/// </para>
///
/// <para>
/// Two claims matter more than the rest and both are here: the file every
/// running agent already has is read rather than discarded, and forgetting one
/// connector's enrollment leaves the others' alone.
/// </para>
/// </summary>
public sealed class EnrollmentStateTests : IDisposable
{
    private const string Bank = "https://bank.internal:8392/";
    private const string Registry = "https://registry.internal:8392/";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "connector-agent-tests", Guid.NewGuid().ToString("N"));

    private readonly AgentStateStore _store;

    public EnrollmentStateTests()
    {
        Directory.CreateDirectory(_root);
        _store = new AgentStateStore(Path.Combine(_root, "agent-state.json"), NullLogger<AgentStateStore>.Instance);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // A temp directory the OS is still holding is not a test failure.
        }
    }

    /// <summary>
    /// THE FILE EVERY RUNNING AGENT HAS IS READ, not thrown away.
    /// </summary>
    /// <remarks>
    /// This is the exact text the single-connector agent wrote, and it is on a
    /// state volume on somebody's NAS right now. Reading it as anything other
    /// than that connector's enrollment costs them a fresh code, a human
    /// present, and - because profiles are filed under the agent that holds
    /// them - every provider registration again from the start.
    /// </remarks>
    [Fact]
    public void The_single_connector_file_is_read_as_that_connectors_enrollment()
    {
        File.WriteAllText(
            _store.FilePath,
            """
            {"agent_id":"agt_old","token":"tok_old","control_plane":"https://bank.internal:8392/",
             "enrolled_at":"2026-01-01T00:00:00+00:00","heartbeat_seconds":45}
            """);

        var stored = _store.Load(Bank);

        Assert.NotNull(stored);
        Assert.Equal("agt_old", stored.AgentId);
        Assert.Equal("tok_old", stored.Token);
        Assert.Equal(Bank, stored.ControlPlane);
        Assert.Equal(45, stored.HeartbeatSeconds);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:00:00+00:00", null), stored.EnrolledAt);
    }

    /// <summary>
    /// AND IT SURVIVES THE SECOND CONNECTOR BEING ADDED, which is what the
    /// upgrade actually looks like: the same container, one more connector in
    /// its configuration, the enrollment it already had still good.
    /// </summary>
    [Fact]
    public void Adding_a_connector_rewrites_the_file_and_keeps_the_old_enrollment()
    {
        File.WriteAllText(
            _store.FilePath,
            """
            {"agent_id":"agt_old","token":"tok_old","control_plane":"https://bank.internal:8392/",
             "enrolled_at":"2026-01-01T00:00:00+00:00","heartbeat_seconds":45}
            """);

        _store.Save(Enrollment("agt_registry", Registry));

        Assert.Equal("agt_old", _store.Load(Bank)?.AgentId);
        Assert.Equal("agt_registry", _store.Load(Registry)?.AgentId);

        // And the file is now the list, so the next connector does not have to
        // guess at the shape either.
        Assert.Contains("\"connections\"", File.ReadAllText(_store.FilePath), StringComparison.Ordinal);
    }

    /// <summary>
    /// A second enrollment for the same connector replaces the first rather
    /// than sitting beside it.
    /// </summary>
    /// <remarks>
    /// One connector issues one identity to this machine at a time. Two
    /// entries would make "which token is this agent's" a matter of ordering,
    /// and the loser would be a revoked token left on disk.
    /// </remarks>
    [Fact]
    public void Re_enrolling_with_one_connector_replaces_its_entry()
    {
        _store.Save(Enrollment("agt_first", Bank));
        _store.Save(Enrollment("agt_second", Bank));
        _store.Save(Enrollment("agt_registry", Registry));

        Assert.Equal("agt_second", _store.Load(Bank)?.AgentId);
        Assert.Equal("agt_registry", _store.Load(Registry)?.AgentId);
    }

    /// <summary>
    /// FORGETTING ONE CONNECTOR LEAVES THE OTHERS ENROLLED.
    /// </summary>
    /// <remarks>
    /// A revoke is one connector's verdict, and the commonest way to meet one
    /// is not a user revoking anything: it is a connector restored from a
    /// backup taken before this agent enrolled, which answers 401 to
    /// everything. Clearing the whole file there would cost the registry
    /// connector beside it its enrollment too - and DUO has no pooled fleet to
    /// fall back on while somebody mints another code.
    /// </remarks>
    [Fact]
    public void Clearing_one_connector_leaves_the_others_enrollment_alone()
    {
        _store.Save(Enrollment("agt_bank", Bank));
        _store.Save(Enrollment("agt_registry", Registry));

        _store.Clear(Bank);

        Assert.Null(_store.Load(Bank));
        Assert.Equal("agt_registry", _store.Load(Registry)?.AgentId);
        Assert.True(File.Exists(_store.FilePath), "the file still holds an enrollment and must not be deleted");
    }

    /// <summary>
    /// And clearing the last one takes the file with it, token and all.
    /// </summary>
    [Fact]
    public void Clearing_the_last_connector_deletes_the_file()
    {
        _store.Save(Enrollment("agt_bank", Bank));

        _store.Clear(Bank);

        Assert.False(File.Exists(_store.FilePath), "a revoked token must not be left on disk");
    }

    /// <summary>
    /// An enrollment issued by another connector is not this connector's.
    /// </summary>
    /// <remarks>
    /// The rule this file has always had, and it is the reason the key is the
    /// control plane: pointing an agent at a different host must force a fresh
    /// enrollment rather than send one service's token to another.
    /// </remarks>
    [Fact]
    public void An_enrollment_from_another_connector_is_not_handed_over()
    {
        _store.Save(Enrollment("agt_bank", Bank));

        Assert.Null(_store.Load(Registry));
    }

    private static AgentEnrollment Enrollment(string agentId, string controlPlane) => new()
    {
        AgentId = agentId,
        Token = "tok_" + agentId,
        ControlPlane = controlPlane,
        EnrolledAt = DateTimeOffset.UnixEpoch,
        HeartbeatSeconds = 30,
    };
}
