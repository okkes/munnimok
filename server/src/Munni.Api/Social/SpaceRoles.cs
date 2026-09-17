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
}
