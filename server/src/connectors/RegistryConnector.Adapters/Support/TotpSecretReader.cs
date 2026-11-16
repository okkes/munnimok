using System.Globalization;
using System.Text;
using System.Web;
using Connector.Kit.Errors;

namespace RegistryConnector.Adapters.Support;

// a bare base32 secret, an otpauth:// URI, or a Google Authenticator otpauth-migration:// export
// a migration blob can hold every second factor a person owns: accepted only with EXACTLY ONE account, else refused by count
internal static class TotpSecretReader
{
    private const string MigrationScheme = "otpauth-migration://";
    private const string UriScheme = "otpauth://";

    public static TotpSecret Read(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.InvalidRequest("totp: nothing to read");
        }

        var text = raw.Trim();

        if (text.StartsWith(MigrationScheme, StringComparison.OrdinalIgnoreCase)) return FromMigration(text);
        if (text.StartsWith(UriScheme, StringComparison.OrdinalIgnoreCase)) return FromUri(text);

        return new TotpSecret { Secret = Totp.FromBase32(text) };
    }

    private static TotpSecret FromUri(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            throw ConnectorException.InvalidRequest("totp: that otpauth address could not be read");
        }

        if (!string.Equals(uri.Host, "totp", StringComparison.OrdinalIgnoreCase))
        {
            // hotp is counter-based: there is no clock, and a stored counter would desynchronise on the first retry
            throw ConnectorException.InvalidRequest(
                $"totp: '{uri.Host}' codes are not time-based, so they cannot be generated here");
        }

        var query = HttpUtility.ParseQueryString(uri.Query);

        return new TotpSecret
        {
            Secret = Totp.FromBase32(query["secret"]),
            Digits = Number(query["digits"], Totp.DefaultDigits),
            PeriodSeconds = Number(query["period"], Totp.DefaultPeriodSeconds),
            Algorithm = Algorithm(query["algorithm"]),
            Issuer = query["issuer"],
        };
    }

    // Google Authenticator's export protobuf (no published schema): secret=1 name=2 issuer=3 algorithm=4 digits=5 type=6
    // algorithm 1=SHA1 2=SHA256 3=SHA512 4=MD5, digits 1=SIX 2=EIGHT, type 1=HOTP 2=TOTP
    private static TotpSecret FromMigration(string text)
    {
        var query = HttpUtility.ParseQueryString(text[(text.IndexOf('?', StringComparison.Ordinal) + 1)..]);
        var data = query["data"];

        if (string.IsNullOrWhiteSpace(data))
        {
            throw ConnectorException.InvalidRequest("totp: that export carries no data");
        }

        byte[] payload;
        try
        {
            payload = Convert.FromBase64String(data.Replace(' ', '+'));
        }
        catch (FormatException)
        {
            throw ConnectorException.InvalidRequest("totp: that export is not readable base64");
        }

        var accounts = new List<TotpSecret>();

        foreach (var (field, value) in Fields(payload))
        {
            if (field != 1 || value is not byte[] entry) continue;

            var parsed = Account(entry);
            if (parsed is not null) accounts.Add(parsed);
        }

        if (accounts.Count == 0)
        {
            throw ConnectorException.InvalidRequest(
                "totp: that export contains no time-based accounts");
        }

        if (accounts.Count > 1)
        {
            // by count, never by issuer: listing the other accounts would mean reading them, which this refuses
            throw ConnectorException.InvalidRequest(
                $"totp: that export contains {accounts.Count} accounts, and this asks for one. " +
                "It is the QR from your authenticator's 'transfer accounts' screen, which carries every " +
                "account you selected - not just this provider's. Export only this one account and paste " +
                "that, or paste the provider's own setup key instead.");
        }

        return accounts[0];
    }

    private static TotpSecret? Account(byte[] entry)
    {
        byte[]? secret = null;
        string? issuer = null;
        var algorithm = TotpAlgorithm.Sha1;
        var digits = Totp.DefaultDigits;
        var timeBased = true;

        foreach (var (field, value) in Fields(entry))
        {
            switch (field)
            {
                case 1 when value is byte[] bytes: secret = bytes; break;
                case 3 when value is byte[] bytes: issuer = Encoding.UTF8.GetString(bytes); break;
                case 4 when value is ulong number:
                    algorithm = number switch
                    {
                        2 => TotpAlgorithm.Sha256,
                        3 => TotpAlgorithm.Sha512,
                        _ => TotpAlgorithm.Sha1,
                    };
                    break;
                case 5 when value is ulong number: digits = number == 2 ? 8 : 6; break;

                // 1 is HOTP: skipped, not refused, so an export holding one HOTP and one TOTP entry still works
                case 6 when value is ulong number: timeBased = number != 1; break;
                default: break;
            }
        }

        if (secret is null || secret.Length == 0 || !timeBased) return null;

        return new TotpSecret
        {
            Secret = secret,
            Digits = digits,
            Algorithm = algorithm,

            // the export URL-encodes spaces as '+' ("BKR+Consumenten"): decoded because it is shown to a human
            Issuer = issuer?.Replace('+', ' '),
        };
    }

    // groups and fixed-width fields are skipped: this format uses neither
    private static IEnumerable<(int Field, object Value)> Fields(byte[] buffer)
    {
        var index = 0;

        while (index < buffer.Length)
        {
            if (!TryVarint(buffer, ref index, out var key)) yield break;

            var field = (int)(key >> 3);
            var wire = (int)(key & 7);

            switch (wire)
            {
                case 0:
                    if (!TryVarint(buffer, ref index, out var number)) yield break;
                    yield return (field, number);
                    break;

                case 2:
                    if (!TryBytes(buffer, ref index, out var bytes)) yield break;
                    yield return (field, bytes);
                    break;

                case 5: index += 4; break;
                case 1: index += 8; break;
                default: yield break;
            }
        }
    }

    private static bool TryBytes(byte[] buffer, ref int index, out byte[] value)
    {
        value = [];

        if (!TryVarint(buffer, ref index, out var length)) return false;

        // range checked before the cast: a varint above int.MaxValue casts to a negative length that passes the bounds guard
        // and throws on the slice; a pasted non-payload must be refused, not crash the parse
        if (length > int.MaxValue) return false;

        var size = (int)length;
        if (index + size > buffer.Length) return false;

        value = buffer[index..(index + size)];
        index += size;

        return true;
    }

    private static bool TryVarint(byte[] buffer, ref int index, out ulong value)
    {
        value = 0;
        var shift = 0;

        while (index < buffer.Length)
        {
            var current = buffer[index++];
            value |= (ulong)(current & 0x7F) << shift;

            if ((current & 0x80) == 0) return true;

            shift += 7;
            if (shift > 63) return false;
        }

        return false;
    }

    private static int Number(string? raw, int fallback) =>
        int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : fallback;

    private static TotpAlgorithm Algorithm(string? raw) => raw?.ToUpperInvariant() switch
    {
        "SHA256" => TotpAlgorithm.Sha256,
        "SHA512" => TotpAlgorithm.Sha512,
        _ => TotpAlgorithm.Sha1,
    };
}
