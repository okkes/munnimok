using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Execution;

/// <summary>
/// The scratch root every job on this machine works in, and the single sweep
/// of it at startup.
/// </summary>
/// <remarks>
/// Scratch directories are per job and are deleted when the job ends, on
/// failure included. What is left at startup was left by a run that did not
/// get to clean up after itself - a kill -9, a power cut - and the residue rule
/// applies to those too: a downloaded bank statement on disk is the leak this
/// architecture exists to prevent.
/// <para>
/// <b>ONCE FOR THE MACHINE, not once per connector, and that is a race rather
/// than a tidiness preference.</b> The sweep used to be the first thing each
/// host did. With several connectors in one process the second host's sweep
/// runs while the first is already enrolling, and a control plane that answers
/// quickly enough would have the first host's job creating a directory that
/// the second deletes out from under it - a fetch failing on a missing path,
/// on a machine nobody is watching, reported as the provider's fault.
/// </para>
/// </remarks>
public sealed class WorkRoot
{
    private readonly ConnectorAgentOptions _options;
    private readonly ILogger<WorkRoot> _logger;

    private int _swept;

    public WorkRoot(ConnectorAgentOptions options, ILogger<WorkRoot> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(logger);

        _options = options;
        _logger = logger;
    }

    public string Directory => _options.WorkRootDirectory;

    /// <summary>Sweeps what a previous run left behind. The second caller does nothing.</summary>
    public void SweepOnce()
    {
        if (Interlocked.Exchange(ref _swept, 1) != 0) return;

        try
        {
            System.IO.Directory.CreateDirectory(Directory);

            foreach (var directory in System.IO.Directory.EnumerateDirectories(Directory))
            {
                try
                {
                    System.IO.Directory.Delete(directory, recursive: true);
                    _logger.LogInformation("swept work directory {Directory} left by a previous run", directory);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _logger.LogWarning(ex, "could not sweep {Directory}", directory);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "could not prepare the work root {Root}", Directory);
        }
    }
}
