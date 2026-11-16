namespace Connector.Kit.Tests;

// moves only when a test moves it, so boundary cases like "expires exactly now" are reachable
internal sealed class TestTime : TimeProvider
{
    public TestTime(DateTimeOffset now) => Now = now;

    public DateTimeOffset Now { get; set; }

    public override DateTimeOffset GetUtcNow() => Now;

    public static DateTimeOffset Anchor { get; } = new(2026, 7, 27, 10, 0, 0, TimeSpan.Zero);

    public static TestTime AtAnchor() => new(Anchor);
}
