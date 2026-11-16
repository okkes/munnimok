namespace ShopConnector.Adapters.Mock;

/// one behaviour per hard thing, so a failure names the thing that broke
public enum MockStoreBehaviour
{
    /// <summary>T1, no challenge, instant. The smoke test.</summary>
    Instant,

    SmsChallenge,

    ImageChallenge,

    /// <summary>Runs long enough to exercise SSE progress and lease renewal.</summary>
    Slow,

    Broken,

    /// <summary>T4 on a BYO agent: the bundle holds a pointer and no secret.</summary>
    Persistent,
}

/// everything a test may vary lives here, so the registered set stays realistic while a test builds a fast one
public sealed record MockStoreProfile
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required MockStoreBehaviour Behaviour { get; init; }

    public string FixtureName { get; init; } = "mock/receipts.json";

    /// <summary>Pause between progress steps. Only the slow profile uses it.</summary>
    public TimeSpan StepDelay { get; init; } = TimeSpan.Zero;

    /// <summary>The only answer the SMS mock accepts. Anything else is <c>mfa_failed</c>.</summary>
    public string SmsCode { get; init; } = "123456";

    /// <summary>The only answer the image mock accepts, compared case-insensitively.</summary>
    public string CaptchaAnswer { get; init; } = "MOCK1";

    /// makes a mock login fail with invalid_credentials: an offline test of the never-retry rule
    public string RejectedPassword { get; init; } = "wrong";
}

public sealed record MockStoreOptions
{
    public TimeSpan SlowStepDelay { get; init; } = TimeSpan.FromSeconds(2);

    public string SmsCode { get; init; } = "123456";

    public string CaptchaAnswer { get; init; } = "MOCK1";

    public string RejectedPassword { get; init; } = "wrong";
}
