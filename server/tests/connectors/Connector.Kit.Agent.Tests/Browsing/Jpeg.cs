namespace Connector.Kit.Agent.Tests;

// the advertised frame size multiplies every returned coordinate, so the pixels must agree; the encoder is the check
internal static class Jpeg
{
    public static bool Looks(byte[] bytes) =>
        bytes.Length > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;

    // every start-of-frame marker is accepted: a SOF0-only parser calls a progressive JPEG "not a JPEG"
    public static (int Width, int Height) SizeOf(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);

        if (!Looks(bytes)) throw new ArgumentException("not a JPEG", nameof(bytes));

        var i = 2;
        while (i + 9 < bytes.Length)
        {
            if (bytes[i] != 0xFF)
            {
                i++;
                continue;
            }

            var marker = bytes[i + 1];
            var length = (bytes[i + 2] << 8) | bytes[i + 3];

            // C0-CF are start-of-frame markers except C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding conditioning)
            if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
            {
                var height = (bytes[i + 5] << 8) | bytes[i + 6];
                var width = (bytes[i + 7] << 8) | bytes[i + 8];
                return (width, height);
            }

            if (length < 2) break;
            i += 2 + length;
        }

        throw new ArgumentException("this JPEG carries no frame header", nameof(bytes));
    }
}
