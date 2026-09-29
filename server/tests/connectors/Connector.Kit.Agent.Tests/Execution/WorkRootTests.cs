using Connector.Kit.Agent.Execution;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// The work root is scratch space for one run: whatever a previous run left
/// there (a crashed job's downloads, a half-written page) is swept once at
/// start-up, and never again while this run's own jobs are writing into it.
/// </summary>
public sealed class WorkRootTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "work-root-tests", Guid.NewGuid().ToString("N"));

    private static WorkRoot Root(string directory) =>
        new(new ConnectorAgentOptions { WorkRootDirectory = directory }, NullLogger<WorkRoot>.Instance);

    [Fact]
    public void The_first_sweep_clears_what_a_previous_run_left_and_a_second_sweep_leaves_new_work_alone()
    {
        Directory.CreateDirectory(Path.Combine(_root, "job_old"));
        File.WriteAllText(Path.Combine(_root, "job_old", "page.html"), "<html></html>");
        File.WriteAllText(Path.Combine(_root, "note.txt"), "only directories are swept");
        var work = Root(_root);

        work.SweepOnce();

        Assert.Equal(_root, work.Directory);
        Assert.False(Directory.Exists(Path.Combine(_root, "job_old")));
        Assert.True(File.Exists(Path.Combine(_root, "note.txt")));

        Directory.CreateDirectory(Path.Combine(_root, "job_new"));
        work.SweepOnce();
        Assert.True(Directory.Exists(Path.Combine(_root, "job_new")));
    }

    [Fact]
    public void A_root_that_is_not_there_yet_is_created_by_the_sweep()
    {
        var nested = Path.Combine(_root, "nested", "work");

        Root(nested).SweepOnce();

        Assert.True(Directory.Exists(nested));
    }

    [Fact]
    public void A_root_that_cannot_be_prepared_is_a_warning_not_a_crash()
    {
        Directory.CreateDirectory(_root);
        var blocked = Path.Combine(_root, "blocked");
        File.WriteAllText(blocked, "a file sits where the work root should be");

        var exception = Record.Exception(() => Root(blocked).SweepOnce());

        Assert.Null(exception);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
