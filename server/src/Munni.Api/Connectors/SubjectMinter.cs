using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Munni.Api.Connectors;

// opaque on purpose: the control plane never learns a user id, e-mail or name; each environment's own salt
// makes the same user a different subject
public sealed class SubjectMinter
{
    /// <summary>Every user subject starts with this; the connector's canary marker never does.</summary>
    public const string Prefix = "u_";

    // only a subject carrying it may be enrolled as a canary, keeping a person's bundle out of that table;
    // the LAB subject carries it, a user subject never does
    public const string CanaryMarker = "canary:";

    private readonly byte[] _key;

    public SubjectMinter(string salt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(salt);
        _key = Encoding.UTF8.GetBytes(salt);
    }

    public string For(Guid userId) => Mint(userId.ToString("D"));

    // #441: a lab run never shows among the person's connections and nothing of it is ingested into a space;
    // a bundle opens only against its own subject, so no other minting path can make a canary
    public string ForLab(Guid userId) => CanaryMarker + Mint($"lab:{userId:D}");

    private string Mint(string material)
    {
        var mac = HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(material));
        return Prefix + Base64Url.EncodeToString(mac)[..21];
    }
}
