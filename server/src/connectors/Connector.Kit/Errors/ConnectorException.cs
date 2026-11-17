using System.Text.Json.Serialization;

namespace Connector.Kit.Errors;

// the only exception crossing an adapter boundary: anything else is mapped to Internal, so a caller never sees a stack trace
public sealed class ConnectorException : Exception
{
    public ConnectorException(ErrorCode code, string? detail = null, Exception? inner = null)
        : base(detail ?? ErrorCatalog.Wire(code), inner)
    {
        Code = code;
        Detail = detail;
    }

    public ErrorCode Code { get; }

    /// <summary>Operator-facing. Never shown to an end user, never localised.</summary>
    public string? Detail { get; }

    // carried on the exception so the interval check (knows the number) and the exception filter (writes the envelope)
    // need nothing between them
    public int? RetryAfterSeconds { get; init; }

    public int HttpStatus => ErrorCatalog.HttpStatus(Code);

    public bool Retriable => ErrorCatalog.IsRetriable(Code);

    public static ConnectorException InvalidCredentials(string? detail = null) =>
        new(ErrorCode.InvalidCredentials, detail);

    public static ConnectorException SessionExpired(string? detail = null) =>
        new(ErrorCode.SessionExpired, detail);

    // the provider's shape moved: needs a human to fix an adapter, and degrades the provider so the next user gets a real
    // message, not a retry
    public static ConnectorException ProviderChanged(string detail) =>
        new(ErrorCode.ProviderChanged, detail);

    public static ConnectorException Blocked(string? detail = null) =>
        new(ErrorCode.BlockedByProvider, detail);

    public static ConnectorException Unsupported(string detail) =>
        new(ErrorCode.UnsupportedResource, detail);

    public static ConnectorException InvalidRequest(string detail) =>
        new(ErrorCode.InvalidRequest, detail);

    public ConnectorError ToError(string? detailId = null, int? retryAfterSeconds = null) => new()
    {
        Code = ErrorCatalog.Wire(Code),
        Retriable = Retriable,
        UserAction = ErrorCatalog.ActionFor(Code),
        MessageKey = ErrorCatalog.MessageKey(Code),
        DetailId = detailId,
        RetryAfterSeconds = retryAfterSeconds,
    };
}

// no free-text message field
public sealed record ConnectorError
{
    public required string Code { get; init; }

    public required bool Retriable { get; init; }

    [JsonPropertyName("user_action")]
    public required UserAction UserAction { get; init; }

    // a key, not prose: the consuming app owns the copy in every language
    [JsonPropertyName("message_key")]
    public required string MessageKey { get; init; }

    /// <summary>Correlates to an operator-visible log entry. Safe to show.</summary>
    [JsonPropertyName("detail_id")]
    public string? DetailId { get; init; }

    [JsonPropertyName("retry_after_seconds")]
    public int? RetryAfterSeconds { get; init; }
}

public sealed record ConnectorErrorEnvelope
{
    public required ConnectorError Error { get; init; }
}
