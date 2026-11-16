using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Connector.Kit.Errors;

namespace Connector.Kit.Security;

// wire form sb_v1.{kid}.{nonce}.{ciphertext}.{tag}, base64url AES-256-GCM; the AAD binds provider, subject and manifest
// version: a stolen blob cannot be replayed for another user, and one from before a breaking adapter change is rejected
public sealed class SealedBundleCodec
{
    private const string Prefix = "sb_v1";

    // cb_v1 keeps credential and session bundles apart: same key, algorithm and AAD, so a mixed-up one would decrypt and
    // then fail deserialising; Open checks the prefix first and refuses the wrong kind as malformed
    private const string CredentialPrefix = "cb_v1";

    private const int NonceBytes = 12;
    private const int TagBytes = 16;

    private readonly IBundleKeyRing _keys;
    private readonly TimeProvider _time;

    public SealedBundleCodec(IBundleKeyRing keys, TimeProvider? time = null)
    {
        _keys = keys;
        _time = time ?? TimeProvider.System;
    }

    public string Seal(BundlePayload payload, BundleBinding binding) =>
        Seal(payload, binding, Prefix);

    public string SealCredentials(CredentialPayload payload, BundleBinding binding) =>
        Seal(payload, binding, CredentialPrefix);

    public CredentialPayload OpenCredentials(string bundle, BundleBinding binding) =>
        Open<CredentialPayload>(bundle, binding, CredentialPrefix);

    private string Seal<T>(T payload, BundleBinding binding, string prefix)
        where T : ISealedPayload
    {
        ArgumentNullException.ThrowIfNull(payload);

        var (kid, key) = _keys.Current;
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(payload, BundleJson.Options);
        var nonce = RandomNumberGenerator.GetBytes(NonceBytes);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagBytes];

        using var gcm = new AesGcm(key, TagBytes);
        gcm.Encrypt(nonce, plaintext, ciphertext, tag, AssociatedData(binding));
        CryptographicOperations.ZeroMemory(plaintext);

        return string.Join('.', prefix, kid, B64(nonce), B64(ciphertext), B64(tag));
    }

    // every rejection (unknown kid, malformed, AAD mismatch, expiry) is SessionExpired so a probing caller learns nothing
    public BundlePayload Open(string bundle, BundleBinding binding) =>
        Open<BundlePayload>(bundle, binding, Prefix);

    private T Open<T>(string bundle, BundleBinding binding, string prefix)
        where T : ISealedPayload
    {
        if (string.IsNullOrWhiteSpace(bundle)) throw ConnectorException.SessionExpired("empty bundle");

        var parts = bundle.Split('.');
        if (parts.Length != 5 || parts[0] != prefix) throw ConnectorException.SessionExpired("malformed bundle");

        if (!_keys.TryGet(parts[1], out var key)) throw ConnectorException.SessionExpired("unknown key id");

        byte[] nonce, ciphertext, tag;
        try
        {
            nonce = UnB64(parts[2]);
            ciphertext = UnB64(parts[3]);
            tag = UnB64(parts[4]);
        }
        catch (FormatException)
        {
            throw ConnectorException.SessionExpired("malformed bundle encoding");
        }

        if (nonce.Length != NonceBytes || tag.Length != TagBytes)
        {
            throw ConnectorException.SessionExpired("malformed bundle envelope");
        }

        var plaintext = new byte[ciphertext.Length];
        try
        {
            using var gcm = new AesGcm(key, TagBytes);
            gcm.Decrypt(nonce, ciphertext, tag, plaintext, AssociatedData(binding));
        }
        catch (CryptographicException)
        {
            throw ConnectorException.SessionExpired("bundle failed authentication");
        }

        T payload;
        try
        {
            payload = JsonSerializer.Deserialize<T>(plaintext, BundleJson.Options)
                      ?? throw ConnectorException.SessionExpired("empty bundle payload");
        }
        catch (JsonException)
        {
            // authenticated but not this route's shape: minted by something other than this codec
            throw ConnectorException.SessionExpired("bundle payload is not readable");
        }

        CryptographicOperations.ZeroMemory(plaintext);

        if (payload.ExpiresAt <= _time.GetUtcNow()) throw ConnectorException.SessionExpired("bundle expired");

        return payload;
    }

    private static byte[] AssociatedData(BundleBinding b) =>
        Encoding.UTF8.GetBytes($"{b.ProviderId}|{b.Subject}|{b.ManifestVersion}");

    private static string B64(ReadOnlySpan<byte> bytes) => Base64Url.EncodeToString(bytes);

    private static byte[] UnB64(string value) => Base64Url.DecodeFromChars(value);
}

/// <summary>Who a bundle is for. Every field is authenticated, none is secret.</summary>
public readonly record struct BundleBinding(string ProviderId, string Subject, int ManifestVersion);

// checked after the AEAD, so an expired blob is refused rather than read
public interface ISealedPayload
{
    DateTimeOffset ExpiresAt { get; }
}

// for a provider whose session cannot be refreshed and would need a daily login; the connector keeps no copy.
// Shorter-lived than a session bundle: a password never rotates and cannot be revoked from here
public sealed record CredentialPayload : ISealedPayload
{
    public int V { get; init; } = 1;

    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }

    public required string Provider { get; init; }

    [JsonPropertyName("issued_at")]
    public required DateTimeOffset IssuedAt { get; init; }

    [JsonPropertyName("expires_at")]
    public required DateTimeOffset ExpiresAt { get; init; }

    // exactly what was posted, revalidated through the manifest's input validator on redemption: no smuggled undeclared key
    public required IReadOnlyDictionary<string, string> Inputs { get; init; }
}

// plaintext of a bundle; for an agent-custody provider it carries no secret, only a pointer to the agent and profile
public sealed record BundlePayload : ISealedPayload
{
    public int V { get; init; } = 1;

    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }

    public required string Provider { get; init; }

    [JsonPropertyName("issued_at")]
    public required DateTimeOffset IssuedAt { get; init; }

    [JsonPropertyName("expires_at")]
    public required DateTimeOffset ExpiresAt { get; init; }

    // tokens for T1/T2, a browser storage state for T2/T3, an agent pointer only for T4
    public required SessionMaterial Material { get; init; }

    // non-secret provider settings (country, language) so a later fetch need not resend them
    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public IReadOnlyList<ReachableAccount> Accounts { get; init; } = [];
}

public sealed record ReachableAccount
{
    [JsonPropertyName("external_id")]
    public required string ExternalId { get; init; }

    public required string Type { get; init; }

    [JsonPropertyName("display_name")]
    public string? DisplayName { get; init; }
}

internal static class BundleJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
