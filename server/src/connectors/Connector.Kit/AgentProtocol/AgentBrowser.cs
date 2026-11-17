using System.Reflection;
using Microsoft.Playwright;

namespace Connector.Kit.AgentProtocol;

// Playwright bundles one Chromium per release, so its version names the browser a bank judges outdated (#562); pooled agents
// renew with every deploy, an own-computer agent is renewed by its owner and this tells them it is time
public static class AgentBrowser
{
    /// <summary>What this build runs, as major.minor.patch.</summary>
    public static string Version { get; } = Read(typeof(IPlaywright).Assembly);

    // behind: naming an older browser than this build's, or none at all
    // (the claim is newer than any agent that does not make it)
    public static bool IsBehind(string? reported) => IsBehind(reported, Version);

    public static bool IsBehind(string? reported, string ours)
    {
        if (!System.Version.TryParse(ours, out var mine)) return false;
        if (string.IsNullOrWhiteSpace(reported)) return true;

        return System.Version.TryParse(reported, out var theirs) && theirs < mine;
    }

    internal static string Read(Assembly playwright)
    {
        // the ASSEMBLY version: Playwright stamps its informational one "1.0.0+commit" on every release
        return playwright.GetName().Version?.ToString(3) ?? "0.0.0";
    }
}
