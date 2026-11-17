using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Execution;

// what is left at startup came from a run that could not clean up (kill -9, power cut): a bank statement on disk is the leak
// ONCE per machine, not per connector: a second host's sweep would delete a directory the first host's job just created
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
