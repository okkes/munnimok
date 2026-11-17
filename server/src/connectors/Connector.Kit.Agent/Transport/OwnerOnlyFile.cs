using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Transport;

/// one definition for both secrets an agent writes (enrollment token, kept browser session)
/// Windows relies on the per-user directory ACL
internal static class OwnerOnlyFile
{
    public static void Restrict(string path, ILogger logger)
    {
        if (OperatingSystem.IsWindows()) return;

        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "could not restrict permissions on {Path}", path);
        }
    }
}
