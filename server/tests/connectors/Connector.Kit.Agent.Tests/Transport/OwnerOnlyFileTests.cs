using Connector.Kit.Agent.Transport;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Transport;

// the state file holds the enrollment token; a file that cannot be restricted is logged, not fatal
public sealed class OwnerOnlyFileTests
{
    [Fact]
    public void The_state_file_is_owner_only_on_unix_and_left_alone_on_windows()
    {
        var path = Path.Combine(Path.GetTempPath(), $"owner-only-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, "{}");
        try
        {
            OwnerOnlyFile.Restrict(path, NullLogger.Instance);

            if (OperatingSystem.IsWindows())
            {
                Assert.True(File.Exists(path));
            }
            else
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
            }
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void A_file_that_is_not_there_is_a_warning_not_a_crash()
    {
        var missing = Path.Combine(Path.GetTempPath(), $"owner-only-missing-{Guid.NewGuid():N}.json");

        var exception = Record.Exception(() => OwnerOnlyFile.Restrict(missing, NullLogger.Instance));

        Assert.Null(exception);
    }
}
