namespace Munni.Api.Social;

/// <summary>
/// Space member roles. Owners manage members/invites and everything a
/// contributor can; contributors read and write data; readers only pull.
/// </summary>
public static class SpaceRoles
{
    public const string Owner = "owner";
    public const string Contributor = "contributor";
    public const string Reader = "reader";

    public static readonly string[] Assignable = [Owner, Contributor, Reader];

    public static bool CanWrite(string role) => role is Owner or Contributor;

    public static bool IsOwner(string role) => role == Owner;

    /// <summary>#505: the error a reader's write gets.</summary>
    public const string ReadOnlyError = "space_read_only";

    /// <summary>
    /// #505: a member who may read but never change the space — a 403 that
    /// names why, so a device tells it apart from lost membership (a bare
    /// Forbid) and stops offering the write instead of retrying it.
    /// </summary>
    public static IResult ReadOnly() => Results.Json(new { error = ReadOnlyError }, statusCode: StatusCodes.Status403Forbidden);
}
