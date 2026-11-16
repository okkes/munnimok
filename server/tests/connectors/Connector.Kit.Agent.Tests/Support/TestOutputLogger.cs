using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests;

// the live view's per-second cost is written as a log line: NullLogger would discard the only number the feature
// is judged on
internal sealed class TestOutputLogger(ITestOutputHelper output) : ILogger
{
    public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

    public bool IsEnabled(LogLevel level) => level >= LogLevel.Debug;

    public void Log<TState>(
        LogLevel level,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        ArgumentNullException.ThrowIfNull(formatter);

        if (!IsEnabled(level)) return;

        try
        {
            output.WriteLine($"{level,-11} {formatter(state, exception)}");
        }
        catch (InvalidOperationException)
        {
            // a background loop logging after the test finished must not fail whatever unrelated test runs next
        }
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }
}
