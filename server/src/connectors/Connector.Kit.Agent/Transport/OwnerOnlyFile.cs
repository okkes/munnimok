using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Transport;

/// <summary>
/// Makes a file on an agent's disk readable by its owner and nobody else,
/// where the platform has a notion of that.
/// </summary>
/// <remarks>
/// ONE DEFINITION RATHER THAN TWO, which is the rule this codebase already
/// applies to the wire encoding for the same reason: a comment cannot keep two
/// definitions in sync, a reference can. There are now two files an agent
/// writes that are worth stealing - the enrollment's bearer token in
/// <see cref="AgentStateStore"/>, and a browser profile's live provider session
/// in <see cref="Browsing.KeptSessionStore"/> - and a permissions rule written
/// out twice is a rule that ends up correct in one of the places.
/// <para>
/// On Windows the inherited ACL of a per-user data directory is the equivalent
/// guarantee, so there is nothing to set and nothing to warn about.
/// </para>
/// </remarks>
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
