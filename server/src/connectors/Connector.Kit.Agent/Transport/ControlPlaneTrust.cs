using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace Connector.Kit.Agent.Transport;

/// production control planes use an internally-issued CA that a container's trust store lacks; this adds that one CA
/// as an extra root for the control plane's client only: chain, dates and name are still checked, machine roots stay
internal static class ControlPlaneTrust
{
    public static Func<HttpRequestMessage, X509Certificate2?, X509Chain?, SslPolicyErrors, bool>? Validator(
        string? caPath)
    {
        if (string.IsNullOrWhiteSpace(caPath)) return null;

        // read once at startup, not per handshake; a swapped CA needs a restart anyway
        var authority = X509CertificateLoader.LoadCertificateFromFile(caPath);

        return (_, certificate, _, errors) =>
        {
            if (errors == SslPolicyErrors.None) return true;

            // a name mismatch is still a failure: only the chain is in question
            if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch)) return false;
            if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable)) return false;
            if (certificate is null) return false;

            using var chain = new X509Chain();

            // CustomRootTrust makes the operator's CA the only root; AllowUnknownCertificateAuthority stops a non-public root
            // failing the build
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(authority);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;

            return chain.Build(certificate)
                   && chain.ChainElements.Count > 0
                   && Rooted(chain, authority);
        };
    }

    /// Build() with AllowUnknownCertificateAuthority forgives an untrusted root, so the last element's thumbprint
    /// is what proves the chain ends at our CA
    private static bool Rooted(X509Chain chain, X509Certificate2 authority) =>
        string.Equals(
            chain.ChainElements[^1].Certificate.Thumbprint,
            authority.Thumbprint,
            StringComparison.OrdinalIgnoreCase);
}
