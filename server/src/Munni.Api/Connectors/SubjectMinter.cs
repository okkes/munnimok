using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Munni.Api.Connectors;

/// <summary>
/// The subject a connector sees for a user: <c>u_</c> + the first 21
/// characters of base64url(HMAC-SHA256(salt, user id)). Opaque on purpose —
/// the control plane never learns a user id, an e-mail or a name, and the
/// same user is a different subject in every environment because every
/// environment has its own salt (docs/connector-integration-plan.md §6).
/// </summary>
public sealed class SubjectMinter
{
    /// <summary>Every user subject starts with this; the connector's canary marker never does.</summary>
    public const string Prefix = "u_";

    private readonly byte[] _key;

    public SubjectMinter(string salt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(salt);
        _key = Encoding.UTF8.GetBytes(salt);
    }

    public string For(Guid userId)
    {
        var mac = HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(userId.ToString("D")));
        return Prefix + Base64Url.EncodeToString(mac)[..21];
    }
}
