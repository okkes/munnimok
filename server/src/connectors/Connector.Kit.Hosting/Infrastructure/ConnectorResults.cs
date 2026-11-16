using System.Reflection;
using Connector.Kit.Errors;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Infrastructure;

// carries a status the closed error catalogue cannot model: answering a challenge twice is a conflict, which has no code
public sealed class ConnectorHttpException : Exception
{
    public ConnectorHttpException(int status, ConnectorException error)
        : base(error?.Message, error)
    {
        ArgumentNullException.ThrowIfNull(error);
        Status = status;
        Error = error;
    }

    public int Status { get; }

    public ConnectorException Error { get; }

    public static ConnectorHttpException Conflict(string detail) =>
        new(StatusCodes.Status409Conflict, new ConnectorException(ErrorCode.InvalidRequest, detail));
}

// the single funnel every response goes through, so "never a bare 500" is a property of the code path
public static class ConnectorResults
{
    // typed so the reference documents the body: ASP.NET reads only the DECLARED return type,
    // and IResult yielded a 200 with no body
    public static ConnectorJsonResult<T> Json<T>(T value) => new(value, StatusCodes.Status200OK);

    // IResult on purpose: PopulateMetadata is static and cannot document a per-call status; callers name responses at MapX
    public static IResult Json<T>(T value, int status) => new ConnectorJsonResult<T>(value, status);

    public static IResult Error(ConnectorException exception, string? detailId = null, int? retryAfterSeconds = null)
    {
        ArgumentNullException.ThrowIfNull(exception);
        return Envelope(exception, exception.HttpStatus, detailId, retryAfterSeconds ?? exception.RetryAfterSeconds);
    }

    public static IResult Error(ConnectorHttpException exception, string? detailId = null)
    {
        ArgumentNullException.ThrowIfNull(exception);
        return Envelope(exception.Error, exception.Status, detailId, null);
    }

    // an unexpected exception becomes Internal with a correlation id only, never a stack trace or a message we did not choose
    public static IResult FromException(Exception exception, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(exception);
        ArgumentNullException.ThrowIfNull(logger);

        switch (exception)
        {
            case ConnectorHttpException http:
                logger.LogInformation("connector error {Code} ({Status}): {Detail}",
                    ErrorCatalog.Wire(http.Error.Code), http.Status, http.Error.Detail);
                return Error(http);

            case ConnectorException connector:
                logger.LogInformation("connector error {Code}: {Detail}",
                    ErrorCatalog.Wire(connector.Code), connector.Detail);
                return Error(connector);

            case OperationCanceledException:
                return Envelope(new ConnectorException(ErrorCode.Internal, "request cancelled"),
                    StatusCodes.Status499ClientClosedRequest, null, null);

            default:
            {
                var detailId = Ids.New(Ids.Error);
                logger.LogError(exception, "unhandled control-plane failure {DetailId}", detailId);
                return Envelope(new ConnectorException(ErrorCode.Internal, "unhandled"),
                    StatusCodes.Status500InternalServerError, detailId, null);
            }
        }
    }

    private static IResult Envelope(ConnectorException error, int status, string? detailId, int? retryAfterSeconds) =>
        Results.Json(
            new ConnectorErrorEnvelope { Error = error.ToError(detailId, retryAfterSeconds) },
            ConnectorJson.Options,
            contentType: null,
            statusCode: status);
}

// IResult helpers erase the return type and TypedResults.Json adds no response metadata,
// so the funnel owns the body type too
public sealed class ConnectorJsonResult<T> : IResult, IEndpointMetadataProvider, IStatusCodeHttpResult, IValueHttpResult<T>
{
    private readonly T _value;

    internal ConnectorJsonResult(T value, int statusCode)
    {
        _value = value;
        StatusCode = statusCode;
    }

    public T? Value => _value;

    public int? StatusCode { get; }

    public Task ExecuteAsync(HttpContext httpContext) =>
        Results.Json(_value, ConnectorJson.Options, contentType: null, statusCode: StatusCode)
            .ExecuteAsync(httpContext);

    // static, so it can only claim the default status; hence Json(value, status) returns a bare IResult
    static void IEndpointMetadataProvider.PopulateMetadata(MethodInfo method, EndpointBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.Metadata.Add(new ProducesResponseTypeMetadata(
            StatusCodes.Status200OK, typeof(T), ["application/json"]));
    }
}
