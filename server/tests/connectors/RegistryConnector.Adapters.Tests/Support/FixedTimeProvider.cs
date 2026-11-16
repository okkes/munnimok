namespace RegistryConnector.Adapters.Tests;

// TOTP depends on the time: against the real clock a test would pass for thirty seconds and then fail
internal sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
}
