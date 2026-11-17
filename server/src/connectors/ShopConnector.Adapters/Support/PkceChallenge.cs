using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace ShopConnector.Adapters.Support;

/// RFC 7636. A native client's redirect scheme can be claimed by any app, so a code can be intercepted;
/// omitting PKCE fails the login outright. Verifier and challenge are one object:
/// a verifier lost between authorize and exchange is the same bug.
internal sealed record PkceChallenge
{
    /// S256 only: plain puts the secret in the URL and protects nothing
    public const string Method = "S256";

    /// never logged: with the code it is what makes a stolen code usable
    public required string Verifier { get; init; }

    public required string Challenge { get; init; }

    /// 32 random bytes = 43 base64url chars, the RFC minimum and 256 bits; the alphabet survives a URL and a form body
    public static PkceChallenge Create() => For(Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)));

    /// lets the offline suite prove the hash rather than take it on faith
    public static PkceChallenge For(string verifier)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(verifier);

        // ASCII, not UTF-8: the spec hashes the verifier's own alphabet, which is ASCII.
        // a tidy-up to Encoding.UTF8 must not change the hash
        return new PkceChallenge
        {
            Verifier = verifier,
            Challenge = Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))),
        };
    }
}
