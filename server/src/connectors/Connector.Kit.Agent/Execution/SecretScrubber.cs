namespace Connector.Kit.Agent.Execution;

// last-ditch: failure detail is free text, and a provider library may echo a request body into its exception message
internal static class SecretScrubber
{
    private const string Mask = "***";

    // shorter values are skipped: a short PIN appears inside ordinary words and masking it destroys the diagnostic
    private const int MinimumLength = 4;

    private const int MaximumDetailLength = 2000;

    // used for log output too: a password in an operator's log aggregator is as leaked as on the wire
    public static string Scrub(string text, IReadOnlyCollection<string> secrets)
    {
        if (string.IsNullOrEmpty(text)) return text;

        var result = text;
        foreach (var secret in secrets)
        {
            if (secret.Length < MinimumLength) continue;
            result = result.Replace(secret, Mask, StringComparison.Ordinal);
        }

        return result;
    }

    public static string? Detail(string? detail, IReadOnlyCollection<string> secrets)
    {
        if (string.IsNullOrEmpty(detail)) return detail;

        var scrubbed = Scrub(detail, secrets);
        return scrubbed.Length > MaximumDetailLength ? scrubbed[..MaximumDetailLength] : scrubbed;
    }
}
