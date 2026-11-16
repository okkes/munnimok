using Connector.Kit.Agent.Transport;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Transport;

// an enrollment code is single-use and HMAC-signed: an agent that loses its entry needs a human to mint another;
// entries are keyed by the control plane that issued them, which is what a bearer token belongs to
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

    // the single-connector file is on somebody's NAS state volume: reading it as anything else costs a fresh code,
    // a human present, and every provider registration again (profiles are filed under the agent)
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

        Assert.Contains("\"connections\"", File.ReadAllText(_store.FilePath), StringComparison.Ordinal);
    }

    // one connector issues one identity per machine at a time: two entries would leave a revoked token on disk
    [Fact]
    public void Re_enrolling_with_one_connector_replaces_its_entry()
    {
        _store.Save(Enrollment("agt_first", Bank));
        _store.Save(Enrollment("agt_second", Bank));
        _store.Save(Enrollment("agt_registry", Registry));

        Assert.Equal("agt_second", _store.Load(Bank)?.AgentId);
        Assert.Equal("agt_registry", _store.Load(Registry)?.AgentId);
    }

    // a revoke is one connector's verdict, often a connector restored from a pre-enrollment backup answering 401 to everything;
    // clearing the whole file would cost the registry connector its enrollment too (DUO has no pooled fleet to fall back on)
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

    [Fact]
    public void Clearing_the_last_connector_deletes_the_file()
    {
        _store.Save(Enrollment("agt_bank", Bank));

        _store.Clear(Bank);

        Assert.False(File.Exists(_store.FilePath), "a revoked token must not be left on disk");
    }

    // the key is the control plane: pointing an agent at another host must force a fresh enrollment,
    // not send one service's token to another
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
