using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace Connector.Kit.Agent.Transport;

/// <summary>
/// Trusting the control plane's own certificate authority, and nothing else.
///
/// <para>
/// The production control planes terminate TLS with an internally-issued
/// certificate, because a LAN is not a trust boundary. An agent has nothing to
/// validate that against - a container's trust store holds public roots and no
/// private one - so every enrollment failed with "the remote certificate is
/// invalid according to the validation procedure" and the whole stack could not
/// talk to itself.
/// </para>
///
/// <para>
/// <b>This is a narrower thing than it looks.</b> It does not disable
/// validation, it does not accept any certificate, and it does not replace the
/// machine's roots - an agent also drives real providers over the public web,
/// and a replaced root store would break every one of them. It adds one CA as
/// an additional trusted root FOR THE CONTROL PLANE'S CLIENT ONLY, and the
/// chain, the dates and the name are all still checked.
/// </para>
/// </summary>
internal static class ControlPlaneTrust
{
    /// <summary>
    /// A validator that accepts a chain rooted in <paramref name="caPath"/>,
    /// or null when there is nothing extra to trust.
    /// </summary>
    public static Func<HttpRequestMessage, X509Certificate2?, X509Chain?, SslPolicyErrors, bool>? Validator(
        string? caPath)
    {
        if (string.IsNullOrWhiteSpace(caPath)) return null;

        // Read once, at startup. A file read per TLS handshake would be a disk
        // hit on every long poll, and a CA swapped underneath a running agent
        // is a restart either way.
        var authority = X509CertificateLoader.LoadCertificateFromFile(caPath);

        return (_, certificate, _, errors) =>
        {
            // The ordinary case, and the one that must keep working: a
            // certificate the machine already trusts needs nothing from here.
            if (errors == SslPolicyErrors.None) return true;

            // A NAME MISMATCH IS STILL A FAILURE. Only the chain is in
            // question - whether this certificate descends from the authority
            // the operator named - and answering "yes" to a certificate issued
            // for somebody else would be the whole point thrown away.
            if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch)) return false;
            if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable)) return false;
            if (certificate is null) return false;

            using var chain = new X509Chain();

            // The custom root is the WHOLE trust decision for this chain:
            // AllowUnknownCertificateAuthority stops the build failing merely
            // because the root is not a public one, and CustomRootTrust is
            // what makes the operator's CA the only root that satisfies it.
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(authority);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;

            return chain.Build(certificate)
                   && chain.ChainElements.Count > 0
                   && Rooted(chain, authority);
        };
    }

    /// <summary>
    /// Whether the chain really ends at the authority we were given.
    /// </summary>
    /// <remarks>
    /// <c>Build</c> returning true with <c>AllowUnknownCertificateAuthority</c>
    /// set is not on its own an answer to "is this OUR certificate": that flag
    /// forgives an untrusted root, which is exactly the thing being asked
    /// about. The thumbprint of the last element is.
    /// </remarks>
    private static bool Rooted(X509Chain chain, X509Certificate2 authority) =>
        string.Equals(
            chain.ChainElements[^1].Certificate.Thumbprint,
            authority.Thumbprint,
            StringComparison.OrdinalIgnoreCase);
}
