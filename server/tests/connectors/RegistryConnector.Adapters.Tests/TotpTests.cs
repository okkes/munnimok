using System.Text;
using Connector.Kit.Errors;
using RegistryConnector.Adapters.Support;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// RFC 6238 Appendix B vectors verbatim: an implementation agreeing only with its own tests is worthless
// against a server nobody controls
public sealed class TotpTests
{
    private static byte[] Seed(int length)
    {
        var seed = new byte[length];
        for (var i = 0; i < length; i++) seed[i] = (byte)('1' + (i % 10 == 9 ? -1 + 10 : i % 10));

        var ascii = Encoding.ASCII.GetBytes("12345678901234567890123456789012345678901234567890123456789012345678901234567890");
        return ascii[..length];
    }

    [Theory]
    [InlineData(59L, "Sha1", 20, "94287082")]
    [InlineData(1111111109L, "Sha1", 20, "07081804")]
    [InlineData(1111111111L, "Sha1", 20, "14050471")]
    [InlineData(1234567890L, "Sha1", 20, "89005924")]
    [InlineData(2000000000L, "Sha1", 20, "69279037")]
    [InlineData(20000000000L, "Sha1", 20, "65353130")]
    [InlineData(59L, "Sha256", 32, "46119246")]
    [InlineData(1111111109L, "Sha256", 32, "68084774")]
    [InlineData(2000000000L, "Sha256", 32, "90698825")]
    [InlineData(59L, "Sha512", 64, "90693936")]
    [InlineData(1111111109L, "Sha512", 64, "25091201")]
    [InlineData(2000000000L, "Sha512", 64, "38618901")]
    public void The_rfc_6238_vectors_are_reproduced_exactly(
        long unixSeconds, string algorithm, int seedLength, string expected)
    {
        // named so the enum stays internal
        var code = Totp.Generate(
            Seed(seedLength),
            DateTimeOffset.FromUnixTimeSeconds(unixSeconds),
            digits: 8,
            periodSeconds: 30,
            algorithm: Enum.Parse<TotpAlgorithm>(algorithm));

        Assert.Equal(expected, code);
    }

    // a short code is still six characters: a provider comparing strings would reject "12345"
    [Fact]
    public void A_six_digit_code_is_padded_to_six_characters()
    {
        var secret = Seed(20);
        var padded = 0;

        for (var step = 0; step < 200; step++)
        {
            var code = Totp.Generate(secret, DateTimeOffset.FromUnixTimeSeconds(step * 30L));

            Assert.Equal(6, code.Length);
            Assert.All(code, c => Assert.InRange(c, '0', '9'));

            if (code[0] == '0') padded++;
        }

        Assert.True(padded > 0, "200 steps produced no code with a leading zero, which is statistically impossible");
    }

    [Fact]
    public void A_code_holds_for_its_step_and_changes_at_the_boundary()
    {
        var secret = Seed(20);

        // 1_700_000_010 is divisible by 30, so it is a step boundary and its step runs to ...039 inclusive
        var atStart = Totp.Generate(secret, DateTimeOffset.FromUnixTimeSeconds(1_700_000_010));
        var atEnd = Totp.Generate(secret, DateTimeOffset.FromUnixTimeSeconds(1_700_000_039));
        var afterwards = Totp.Generate(secret, DateTimeOffset.FromUnixTimeSeconds(1_700_000_040));

        Assert.Equal(atStart, atEnd);
        Assert.NotEqual(atStart, afterwards);
    }

    [Fact]
    public void A_bare_base32_secret_is_read_with_spaces_and_any_casing()
    {
        var plain = TotpSecretReader.Read("JBSWY3DPEHPK3PXP");
        var spaced = TotpSecretReader.Read("jbsw y3dp ehpk 3pxp");
        var padded = TotpSecretReader.Read("JBSWY3DPEHPK3PXP=");

        Assert.Equal(plain.Secret, spaced.Secret);
        Assert.Equal(plain.Secret, padded.Secret);

        Assert.Equal(6, plain.Digits);
        Assert.Equal(30, plain.PeriodSeconds);
        Assert.Equal(TotpAlgorithm.Sha1, plain.Algorithm);
    }

    [Fact]
    public void An_otpauth_uri_carries_its_own_parameters()
    {
        var read = TotpSecretReader.Read(
            "otpauth://totp/Example:me@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60&algorithm=SHA256");

        Assert.Equal(TotpSecretReader.Read("JBSWY3DPEHPK3PXP").Secret, read.Secret);
        Assert.Equal(8, read.Digits);
        Assert.Equal(60, read.PeriodSeconds);
        Assert.Equal(TotpAlgorithm.Sha256, read.Algorithm);
        Assert.Equal("Example", read.Issuer);
    }

    // counter-based codes have no clock and a stored counter would desync on retry; refused by name, else wrong codes forever
    [Fact]
    public void A_counter_based_uri_is_refused_by_name()
    {
        var error = Assert.Throws<ConnectorException>(
            () => TotpSecretReader.Read("otpauth://hotp/Example:me?secret=JBSWY3DPEHPK3PXP&counter=1"));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.Contains("not time-based", error.Detail, StringComparison.Ordinal);
    }

    // a protobuf length is a 64-bit varint: cast to int it goes negative above int.MaxValue,
    // passes the bounds guard and throws on the slice
    [Theory]
    // length varint 0xFFFFFFFF: four bytes of payload claiming four billion
    [InlineData(new byte[] { 0x12, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 0x01, 0x02, 0x03, 0x04 })]
    // one bit past int.MaxValue, the boundary where the cast turns negative
    [InlineData(new byte[] { 0x12, 0x80, 0x80, 0x80, 0x80, 0x08, 0x01 })]
    public void A_paste_that_is_not_an_export_is_refused_rather_than_crashed_on(byte[] blob)
    {
        var uri = "otpauth-migration://offline?data="
                  + Uri.EscapeDataString(Convert.ToBase64String(blob));

        var error = Assert.Throws<ConnectorException>(() => TotpSecretReader.Read(uri));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
    }

    // Google Authenticator never shows the secret; its export QR is the only way out, so the format is read
    [Fact]
    public void A_single_account_export_is_read()
    {
        var blob = Migration([("JBSWY3DPEHPK3PXP", "BKR Consumenten", 6)]);

        var read = TotpSecretReader.Read(blob);

        Assert.Equal(TotpSecretReader.Read("JBSWY3DPEHPK3PXP").Secret, read.Secret);
        Assert.Equal(6, read.Digits);
        Assert.Equal("BKR Consumenten", read.Issuer);
    }

    // the export QR carries every account the person ticked (bank, mail, employer):
    // refused BY COUNT, never by issuer, so none is read
    [Fact]
    public void A_multi_account_export_is_refused_without_naming_what_else_was_in_it()
    {
        var blob = Migration(
        [
            ("JBSWY3DPEHPK3PXP", "BKR Consumenten", 6),
            ("KRSXG5CTMVRXEZLU", "A Bank", 6),
            ("MFRGGZDFMZTWQ2LK", "Somebody's Mail", 6),
        ]);

        var error = Assert.Throws<ConnectorException>(() => TotpSecretReader.Read(blob));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.Contains("3 accounts", error.Detail, StringComparison.Ordinal);

        // the other issuers are not repeated back: reading them out is what is refused
        Assert.DoesNotContain("A Bank", error.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("Mail", error.Detail, StringComparison.Ordinal);

        Assert.Contains("only this one account", error.Detail, StringComparison.Ordinal);
    }

    // builds the payload so the reader is tested against the format, not a fixture copied from a real phone
    private static string Migration(IReadOnlyList<(string Secret, string Issuer, int Digits)> accounts)
    {
        var payload = new List<byte>();

        foreach (var (secret, issuer, digits) in accounts)
        {
            var entry = new List<byte>();

            Bytes(entry, 1, TotpSecretReader_Base32(secret));
            Bytes(entry, 2, Encoding.UTF8.GetBytes($"user@{issuer.Replace(' ', '-')}.test"));
            Bytes(entry, 3, Encoding.UTF8.GetBytes(issuer.Replace(' ', '+')));
            Varint(entry, 4, 1);
            Varint(entry, 5, digits == 8 ? 2ul : 1ul);
            Varint(entry, 6, 2);

            Bytes(payload, 1, [.. entry]);
        }

        return "otpauth-migration://offline?data=" +
               Uri.EscapeDataString(Convert.ToBase64String([.. payload]));
    }

    private static byte[] TotpSecretReader_Base32(string secret) => Totp.FromBase32(secret);

    private static void Varint(List<byte> into, int field, ulong value)
    {
        into.Add((byte)((field << 3) | 0));
        Varint(into, value);
    }

    private static void Bytes(List<byte> into, int field, byte[] value)
    {
        into.Add((byte)((field << 3) | 2));
        Varint(into, (ulong)value.Length);
        into.AddRange(value);
    }

    private static void Varint(List<byte> into, ulong value)
    {
        while (value >= 0x80)
        {
            into.Add((byte)((value & 0x7F) | 0x80));
            value >>= 7;
        }

        into.Add((byte)value);
    }
}
