using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Connector.Kit.Agent.Transport;

namespace Connector.Kit.Agent.Tests.Transport;

/// <summary>
/// How an agent decides to trust the control plane's certificate when the
/// operator named a private authority: the machine's own roots keep working,
/// a certificate that descends from the named authority is accepted, and
/// everything else — a name for somebody else, a different authority, no
/// certificate at all — is refused.
/// </summary>
public sealed class ControlPlaneTrustTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "control-plane-trust", Guid.NewGuid().ToString("N"));

    public ControlPlaneTrustTests() => Directory.CreateDirectory(_dir);

    [Fact]
    public void No_authority_named_means_no_validator_of_our_own()
    {
        Assert.Null(ControlPlaneTrust.Validator(null));
        Assert.Null(ControlPlaneTrust.Validator("  "));
    }

    [Fact]
    public void The_machines_own_trust_keeps_working_and_a_name_for_somebody_else_never_passes()
    {
        using var authority = Authority("CN=munni test CA");
        var validator = ControlPlaneTrust.Validator(Write(authority))!;
        using var leaf = Leaf(authority, "CN=connector.test");

        Assert.True(validator(new HttpRequestMessage(), leaf, null, SslPolicyErrors.None));
        Assert.False(validator(new HttpRequestMessage(), leaf, null, SslPolicyErrors.RemoteCertificateNameMismatch));
        Assert.False(validator(new HttpRequestMessage(), null, null, SslPolicyErrors.RemoteCertificateNotAvailable));
        Assert.False(validator(new HttpRequestMessage(), null, null, SslPolicyErrors.RemoteCertificateChainErrors));
    }

    [Fact]
    public void A_certificate_from_the_named_authority_is_trusted_and_one_from_another_is_not()
    {
        using var authority = Authority("CN=munni test CA");
        using var other = Authority("CN=some other CA");
        var validator = ControlPlaneTrust.Validator(Write(authority))!;

        using var ours = Leaf(authority, "CN=connector.test");
        using var theirs = Leaf(other, "CN=connector.test");

        Assert.True(validator(new HttpRequestMessage(), ours, null, SslPolicyErrors.RemoteCertificateChainErrors));
        Assert.False(validator(new HttpRequestMessage(), theirs, null, SslPolicyErrors.RemoteCertificateChainErrors));
    }

    private string Write(X509Certificate2 authority)
    {
        var path = Path.Combine(_dir, $"{Guid.NewGuid():N}.crt");
        File.WriteAllBytes(path, authority.Export(X509ContentType.Cert));
        return path;
    }

    private static X509Certificate2 Authority(string subject)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        var now = DateTimeOffset.UtcNow.AddMinutes(-5);
        return request.CreateSelfSigned(now, now.AddYears(1));
    }

    private static X509Certificate2 Leaf(X509Certificate2 authority, string subject)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        var now = DateTimeOffset.UtcNow.AddMinutes(-5);
        var serial = new byte[16];
        RandomNumberGenerator.Fill(serial);
        serial[0] &= 0x7f;
        // the leaf carries no private key: the validator only ever sees the public half
        return request.Create(authority, now, now.AddMonths(6), serial);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }
}
