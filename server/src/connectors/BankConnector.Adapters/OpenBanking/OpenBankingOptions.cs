namespace BankConnector.Adapters.OpenBanking;

// a party exists only when both are set: BankAdapters.Real registers it then, never a stand-in
public sealed record GoCardlessOptions
{
    public string? SecretId { get; init; }

    public string? SecretKey { get; init; }

    public string BaseUrl { get; init; } = "https://bankaccountdata.gocardless.com/api/v2/";

    public bool Configured => !string.IsNullOrWhiteSpace(SecretId) && !string.IsNullOrWhiteSpace(SecretKey);
}

// environment files carry the PEM as one line with \n escapes; the client unescapes
public sealed record EnableBankingOptions
{
    public string? ApplicationId { get; init; }

    public string? PrivateKeyPem { get; init; }

    public string BaseUrl { get; init; } = "https://api.enablebanking.com/";

    public bool Configured => !string.IsNullOrWhiteSpace(ApplicationId) && !string.IsNullOrWhiteSpace(PrivateKeyPem);
}
