using Connector.Kit.Errors;

namespace BankConnector.Adapters.Ing;

internal static class IngCalls
{
    /// 206 Partial Content is a success: ING answers full, ordinary transaction pages with it
    public static string Body(IngCall call, string what, Action<string>? note = null)
    {
        // the refusal is quoted (capped at 400, single line): a gateway says what was missing; nothing of the request is
        // quoted, its headers may carry a token
        if (call.Status is < 200 or > 299 && !string.IsNullOrWhiteSpace(call.Body))
        {
            var quoted = call.Body.Length > 400 ? call.Body[..400] : call.Body;

            note?.Invoke($"{IngAdapter.ProviderId}: {what} refused with: {quoted.ReplaceLineEndings(" ")}");
        }

        if (call.Status is 401 or 403)
        {
            throw ConnectorException.SessionExpired(
                $"{IngAdapter.ProviderId}: {what} answered {call.Status}, so the stored session is over. " +
                "ING asks for a second factor on every sign-in, so this needs a person and their phone.");
        }

        if (call.Status is < 200 or > 299 || string.IsNullOrWhiteSpace(call.Body))
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: {what} answered {call.Status} with {call.Body?.Length ?? 0} characters");
        }

        // a signed-out browser does not always get a 401: markup where JSON was asked is an expired session, not a changed bank
        var opening = call.Body.AsSpan().TrimStart();

        if (opening.StartsWith("<", StringComparison.Ordinal))
        {
            throw ConnectorException.SessionExpired(
                $"{IngAdapter.ProviderId}: {what} was answered with a page rather than data, which is what " +
                "ING serves a browser it no longer recognises.");
        }

        return call.Body;
    }
}
