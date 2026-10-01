using Connector.Kit.Errors;

namespace BankConnector.Adapters.Ing;

/// <summary>What an answer from ING means.</summary>
internal static class IngCalls
{
    /// <summary>
    /// Turns a reading into either a body or the right exception.
    /// </summary>
    /// <remarks>
    /// <b>206 IS A SUCCESS HERE.</b> ING answers its transactions endpoint with
    /// <c>206 Partial Content</c> on a full, ordinary page - both captured pages
    /// came back that way - because the answer is one cursor's worth of a longer
    /// feed. Anything treating 2xx as "200 only" would reject every page of
    /// data this adapter exists to read.
    /// </remarks>
    public static string Body(IngCall call, string what, Action<string>? note = null)
    {
        // THE REFUSAL ITSELF, QUOTED.
        //
        // A gateway that refuses a call usually says what was missing, and that
        // sentence is the difference between another live sign-in and an answer.
        // MediaMarkt's first fetch died on "page 2 answered 400 with 406
        // characters" - 406 characters that named the problem exactly and that
        // nobody could read.
        //
        // Capped and single-lined so a page of HTML cannot land in an operator's
        // terminal. Nothing from the request is quoted, only the answer: the
        // headers this connector repeats may carry a token.
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

        // A SIGNED-OUT BROWSER DOES NOT ALWAYS GET A 401. Asked for JSON and
        // handed markup, a reader that only looked at the status would put an
        // HTML login page through the JSON parser and report the bank as having
        // changed, when the truth is an expired session and a sign-in screen.
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
