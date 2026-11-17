using System.Text.Json.Serialization;

namespace Connector.Kit.Errors;

[JsonConverter(typeof(JsonStringEnumConverter<ErrorCode>))]
public enum ErrorCode
{
    /// <summary>The provider rejected the credentials. NEVER retried. See <see cref="ErrorCatalog"/>.</summary>
    InvalidCredentials,

    SessionExpired,

    MfaFailed,

    MfaTimeout,

    ChallengeExpired,

    /// <summary>The provider is deliberately refusing us. We stop; we do not escalate.</summary>
    BlockedByProvider,

    /// <summary>The provider's shape moved. Pages an operator and degrades the provider.</summary>
    ProviderChanged,

    ProviderUnavailable,

    RateLimited,

    AgentUnavailable,

    // not AgentUnavailable: revocation replaces the token hash, so a started agent is answered 401, stops and wipes its
    // profiles; "start your agent" would loop with no exit, hence UserAction.Reconnect
    AgentRevoked,

    UnsupportedResource,

    InvalidRequest,

    ConsentExpired,

    ReconciliationFailed,

    Internal,
}

[JsonConverter(typeof(JsonStringEnumConverter<UserAction>))]
public enum UserAction
{
    None,

    Retry,

    Reauth,

    Reconnect,

    Wait,

    StartYourAgent,
}
