using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Errors;

namespace RegistryConnector.Adapters.Support;

// RFC 6238, written not packaged: Appendix B test vectors give an answer key to check against
// storing the secret to skip the per-sign-in code weakens the second factor and is never the default (see Bkr.BkrManifest)
internal static class Totp
{
    public const int DefaultPeriodSeconds = 30;

    public const int DefaultDigits = 6;

    public static string Generate(
        ReadOnlySpan<byte> secret,
        DateTimeOffset at,
        int digits = DefaultDigits,
        int periodSeconds = DefaultPeriodSeconds,
        TotpAlgorithm algorithm = TotpAlgorithm.Sha1)
    {
        if (secret.Length == 0) throw ConnectorException.InvalidRequest("totp: the secret is empty");
        if (digits is < 6 or > 8) throw ConnectorException.InvalidRequest($"totp: {digits} digits is not 6, 7 or 8");
        if (periodSeconds <= 0) throw ConnectorException.InvalidRequest("totp: the period must be positive");

        var counter = Math.Max(0, at.ToUnixTimeSeconds()) / periodSeconds;

        Span<byte> message = stackalloc byte[8];
        for (var i = 7; i >= 0; i--)
        {
            message[i] = (byte)(counter & 0xFF);
            counter >>= 8;
        }

        Span<byte> mac = stackalloc byte[64];
        var written = algorithm switch
        {
            TotpAlgorithm.Sha1 => HMACSHA1.HashData(secret, message, mac),
            TotpAlgorithm.Sha256 => HMACSHA256.HashData(secret, message, mac),
            TotpAlgorithm.Sha512 => HMACSHA512.HashData(secret, message, mac),
            _ => throw ConnectorException.InvalidRequest($"totp: unsupported algorithm '{algorithm}'"),
        };

        // dynamic truncation, RFC 4226 section 5.3
        var offset = mac[written - 1] & 0x0F;

        var binary = ((mac[offset] & 0x7F) << 24)
                     | ((mac[offset + 1] & 0xFF) << 16)
                     | ((mac[offset + 2] & 0xFF) << 8)
                     | (mac[offset + 3] & 0xFF);

        var modulo = (int)Math.Pow(10, digits);

        // Left-padded: "012345" is a valid code and a provider comparing
        // strings would reject "12345".
        return (binary % modulo).ToString(CultureInfo.InvariantCulture).PadLeft(digits, '0');
    }

    // RFC 4648 base32, case-insensitive, padding optional, spaces ignored: providers print secrets grouped in fours
    public static byte[] FromBase32(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.InvalidRequest("totp: the secret is empty");
        }

        const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

        var bytes = new List<byte>(raw.Length * 5 / 8 + 1);
        var buffer = 0;
        var bits = 0;

        foreach (var character in raw)
        {
            if (character is ' ' or '-' or '=') continue;

            var value = Alphabet.IndexOf(char.ToUpperInvariant(character), StringComparison.Ordinal);
            if (value < 0)
            {
                throw ConnectorException.InvalidRequest(
                    $"totp: '{character}' is not a base32 character; an authenticator secret is A-Z and 2-7");
            }

            buffer = (buffer << 5) | value;
            bits += 5;

            if (bits < 8) continue;

            bits -= 8;
            bytes.Add((byte)((buffer >> bits) & 0xFF));
        }

        if (bytes.Count == 0)
        {
            throw ConnectorException.InvalidRequest("totp: the secret decoded to nothing");
        }

        return [.. bytes];
    }
}

internal enum TotpAlgorithm
{
    Sha1,
    Sha256,
    Sha512,
}

internal sealed record TotpSecret
{
    public required byte[] Secret { get; init; }

    public int Digits { get; init; } = Totp.DefaultDigits;

    public int PeriodSeconds { get; init; } = Totp.DefaultPeriodSeconds;

    public TotpAlgorithm Algorithm { get; init; } = TotpAlgorithm.Sha1;

    /// <summary>Who the entry is for, where the source stated it. Never a secret.</summary>
    public string? Issuer { get; init; }

    public string Now(TimeProvider time) =>
        Totp.Generate(Secret, time.GetUtcNow(), Digits, PeriodSeconds, Algorithm);
}
