namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// The operator's GoCardless Bank Account Data credentials
/// (<c>BankAdapters:GoCardless:*</c>). A party exists only when both are set —
/// <see cref="BankAdapters.Real"/> registers it then, never a stand-in.
/// </summary>
public sealed record GoCardlessOptions
{
    public string? SecretId { get; init; }

    public string? SecretKey { get; init; }

    public string BaseUrl { get; init; } = "https://bankaccountdata.gocardless.com/api/v2/";

    public bool Configured => !string.IsNullOrWhiteSpace(SecretId) && !string.IsNullOrWhiteSpace(SecretKey);
}

/// <summary>
/// The operator's Enable Banking application (<c>BankAdapters:EnableBanking:*</c>):
/// the application id is the JWT's key id, the PEM signs it. Environment
/// files carry the PEM as one line with <c>\n</c> escapes; the client
/// unescapes.
/// </summary>
public sealed record EnableBankingOptions
{
    public string? ApplicationId { get; init; }

    public string? PrivateKeyPem { get; init; }

    public string BaseUrl { get; init; } = "https://api.enablebanking.com/";

    public bool Configured => !string.IsNullOrWhiteSpace(ApplicationId) && !string.IsNullOrWhiteSpace(PrivateKeyPem);
}
