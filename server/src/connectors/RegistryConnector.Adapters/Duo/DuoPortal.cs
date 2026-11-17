using System.Text.Json;

using Connector.Kit.Browsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Microsoft.Playwright;

namespace RegistryConnector.Adapters.Duo;

// Url is post-redirect: it tells a dead session from a rebuilt endpoint; Headers/Sent are names only, values are credentials
// NotReached is the browser's own words for a call that never left the page, set with Status 0
internal readonly record struct DuoReading(
    int Status,
    string Url,
    string? Body,
    IReadOnlyList<string>? Headers = null,
    IReadOnlyList<string>? Sent = null,
    string? NotReached = null);

// behind an interface so which calls are made and allowed, and what a bad answer means, are tested without a browser
internal interface IDuoPortal
{
    // required before reads: they use the page's own fetch, same-origin only while on DUO; a browser restored from cookies
    // starts on about:blank and every read dies as Failed to fetch
    Task<string> OpenAsync(string url, CancellationToken ct);

    // only the negative is honest: a portal address proves nothing (StartUrl lands on the dashboard before bouncing)
    // false means still on DUO: a live session or a slow bounce, so nothing decides on this alone
    Task<bool> BouncesToSignInAsync(TimeSpan patience, CancellationToken ct);

    Task<DuoReading> ReadAsync(string url, CancellationToken ct);

    // like ASN's probe: selectors, roles and counts, no input values or image bytes; failures count against the
    // citizen's DigiD, so the diagnosis must travel with the first one
    Task<string> DescribeAsync(CancellationToken ct);
}

// through the page's own fetch: the session is the browser's cookie jar and this uses it without copying cookies out
internal sealed class PageDuoPortal(IPage page, DuoOptions options) : IDuoPortal
{
    // the token is read from a response and put back on the next request inside the tab: pfd services 401 without it
    // kept in sessionStorage, not window: a mid-sequence navigation destroys window; window.name would leak it to DigiD
    // window is the fallback where sessionStorage throws; internal so a test pins the store
    internal const string FetchScript = """
    async ([url, tokenHeader, carryKey]) => {
      const store = (() => {
        try {
          const kept = sessionStorage.getItem(carryKey);
          if (kept) return JSON.parse(kept);
        } catch (e) {
          // No session store on this origin. The page's own object still has
          // whatever the last call in THIS page put there.
        }
        return window.__duoCarry || {};
      })();

      // Lowercase, so that the names this logs read the same whichever half
      // of the pair they came from: the store's keys arrive from
      // Headers.forEach, which lowercases, and a log line that said
      // "sent [Accept authorization]" would invite somebody to read the
      // casing as meaning something.
      const headers = Object.assign({ 'accept': 'application/json' }, store);

      // Before the fetch, because after it there may be no page left to ask.
      // Names only - this is the log's answer to "did the request that got a
      // 401 actually carry a token".
      const sent = Object.keys(headers);

      const response = await fetch(url, { credentials: 'same-origin', headers });

      const names = [];
      response.headers.forEach((value, name) => {
        names.push(name);
        if (value && name.toLowerCase() === tokenHeader.toLowerCase()) store[name] = value;
      });

      window.__duoCarry = store;
      try {
        sessionStorage.setItem(carryKey, JSON.stringify(store));
      } catch (e) {
        // Blocked site data, or an opaque origin. The window copy above is
        // then the only carry there is, which is what shipped before this.
      }

      return {
        status: response.status,
        url: response.url,
        body: await response.text(),
        headers: names,
        sent,
      };
    }
    """;

    // our own key: DUO's app uses this store and a shared key would corrupt the portal; not in DuoOptions, DUO cannot rename it
    internal const string CarryKey = "__connector_duo_carry";

    public async Task<string> OpenAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        await page.GotoAsync(url).ConfigureAwait(false);

        return page.Url;
    }

    public async Task<bool> BouncesToSignInAsync(TimeSpan patience, CancellationToken ct)
    {
        // Playwright waits take no token: cancelled only before the wait, which SignedOutBounceSeconds bounds
        ct.ThrowIfCancellationRequested();

        try
        {
            // the negation of the predicate the rest of the adapter settles on: two meanings of "signed in" would disagree
            await page.WaitForURLAsync(
                    url => !DuoSignedInWatcher.SignedIn(url, options),
                    new PageWaitForURLOptions { Timeout = (float)patience.TotalMilliseconds })
                .ConfigureAwait(false);

            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // still on DUO when the patience ran out: a live session, or a bounce slow to load; both go on to the session endpoint
            return false;
        }
    }

    public async Task<DuoReading> ReadAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        JsonElement answer;

        try
        {
            answer = await page
                .EvaluateAsync<JsonElement>(
                    FetchScript, new object[] { url, options.SessionTokenHeader, CarryKey })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // a call that could not be made (page navigated, not on DUO's origin) is a status-less reading: DuoCalls decides its meaning
            // the browser's words go in NotReached, not the body: a body message reads downstream as a refusal by DUO
            // the url is where the PAGE is now: into the SAML chain is a dead session, within DUO is not
            return new DuoReading(0, page.Url, null, NotReached: ex.Message);
        }

        return new DuoReading(
            answer.Int32("status") ?? 0,
            answer.Text("url") ?? url,

            // untrimmed: a parser is entitled to the bytes the provider sent
            answer.Child("body") is { ValueKind: JsonValueKind.String } body ? body.GetString() : null,
            Names(answer, "headers"),

            // per call, not a running total: only what the call that got the 401 presented matters
            Names(answer, "sent"));
    }

    public async Task<string> DescribeAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        try
        {
            return PageShape.Describe(
                await page.EvaluateAsync<JsonElement>(PageShape.Script).ConfigureAwait(false));
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // a probe miss must not fail: it runs after something went wrong, and a second exception took the hand-over down before
            return $"the page could not be described ({ex.GetType().Name})";
        }
    }

    private static List<string> Names(JsonElement answer, string property) =>
        [.. answer.Items(property).Select(n => n.Text()).Where(n => n is not null).Select(n => n!)];
}

// a URL cannot answer this: mijn.duo.nl redirects to the portal dashboard before bouncing into SAML, so the address
// reported a finished login 80 ms after the live view opened; ask DUO instead, as Coolblue's fix did
internal static class DuoSession
{
    // strict about shape, not value: a signed-out visitor gets HTML, so anything but an object with the profile field is a no
    public static bool Confirmed(string? json, DuoOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrWhiteSpace(json)) return false;

        try
        {
            using var document = JsonDocument.Parse(json);

            return document.RootElement.Text(options.SessionProfileField) is not null;
        }
        catch (JsonException)
        {
            // DUO's sign-in page, most likely. Not a session.
            return false;
        }
    }
}

// Required false = enrichment, may be missing without costing the balance; Dossier = the one call allowed to read it
// SessionConfirmed: DUO's session endpoint already named a profile in this run
internal readonly record struct DuoCall(
    string Path,
    bool Required,
    bool Dossier = false,
    bool SessionConfirmed = false);

internal static class DuoCalls
{
    // InvalidOperationException, not ConnectorException: reading the dossier is a bug here, not a provider fault.
    // a code rule so whoever adds an endpoint cannot forget it
    public static async Task<string?> ReadAsync(
        IDuoPortal portal,
        DuoOptions options,
        DuoCall call,
        CancellationToken ct,
        Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(portal);
        ArgumentNullException.ThrowIfNull(options);

        var url = options.ServicesRoot + call.Path;

        RefuseDossier(url, options, call.Dossier);

        var reading = await portal.ReadAsync(url, ct).ConfigureAwait(false);

        Report(reading, options, call.Path, note);

        // status 0: the request never reached DUO (a navigation killed it): nothing booked, GET only, so one retry is safe
        // once only: a second interruption means the page is still moving, and a loop would race a redirect on a job spending DigiD
        // a page that moved INTO the sign-in chain is not retried: that is an ended session, read below
        if (reading.Status is 0 && !Bounced(reading, options))
        {
            reading = await portal.ReadAsync(url, ct).ConfigureAwait(false);

            Report(reading, options, call.Path, note, again: true);
        }

        // before the body: a dead session and a rebuilt endpoint both look like unexpected JSON but need a sign-in vs an engineer
        // no session expiry has ever been observed (two captures, four runs): the bounce is the only shape called an expiry
        if (Bounced(reading, options)) throw SessionOver(reading, call.Path);

        // a refusal after DUO named the profile is not a dead session: ForceAuthn makes "sign in again" a full DigiD login that
        // Logius counts against the citizen (four cost on 2026-09-20); ProviderChanged, not SessionExpired (which says Reauth)
        if (reading.Status is 401 or 403 && call.SessionConfirmed)
        {
            return RefusedAfterConfirmation(reading, options, call, note);
        }

        if (reading.Status is 401 or 403)
        {
            // nothing confirmed a session in this run, so a refusal may be a really ended one; the session call itself takes this path
            throw ConnectorException.SessionExpired(
                $"{DuoAdapter.ProviderId}: {call.Path} answered {reading.Status} from the portal's own services, and " +
                "nothing has confirmed a session in this run. Whether that means the session is over or that " +
                "this call is missing something DUO's own page sends, the log line above quotes DUO's answer " +
                "verbatim.");
        }

        if (reading.Status is < 200 or > 299 || string.IsNullOrWhiteSpace(reading.Body))
        {
            // enrichment may be missing: losing an interest rate must not cost the balance
            if (!call.Required) return null;

            throw Unanswered(reading, call.Path);
        }

        return reading.Body;
    }

    private static void RefuseDossier(string url, DuoOptions options, bool dossier)
    {
        // `dossier` is the only way past the refusal: its one call site is guarded by the caller asking for the ledger
        // and the reader takes only movements and one instalment
        if (!dossier && url.Contains(options.ForbiddenPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"{DuoAdapter.ProviderId}: '{options.ForbiddenPath}' is the customer dossier and this connector " +
                "must never call it. It answers with a BSN, both parents, a partner, twenty years of tax income, " +
                "IBANs and every address the account holder has lived at. Whatever field was wanted from it, the " +
                "answer is to do without - see the note on StudentDebt for the one this connector already forgoes.");
        }
    }

    private static ConnectorException SessionOver(DuoReading reading, string path)
    {
        // status 0 is a call that never landed because the page navigated to DigiD mid-fetch: not worded as DUO having answered
        return ConnectorException.SessionExpired(
            reading.Status is 0
                ? $"{DuoAdapter.ProviderId}: {path} never landed, because the page left for the sign-in " +
                  "chain while the call was in flight - so the stored session is over. DUO sets ForceAuthn, " +
                  "so this needs a new DigiD sign-in and there is nothing to refresh."
                : $"{DuoAdapter.ProviderId}: {path} was answered from the sign-in chain rather than the " +
                  "portal, so the stored session is over. DUO sets ForceAuthn, so this needs a new DigiD " +
                  "sign-in and there is nothing to refresh.");
    }

    private static string? RefusedAfterConfirmation(
        DuoReading reading, DuoOptions options, DuoCall call, Action<string>? note)
    {
        // a refused enrichment call costs only the enrichment, as for every other bad status; both failed 2026-09-20 runs
        // died on optional calls with the amounts already in hand
        if (!call.Required)
        {
            note?.Invoke(
                $"{DuoAdapter.ProviderId}: {call.Path} answered {reading.Status}, but {options.SessionPath} " +
                "named a profile in this same run, so the session is alive and this is enrichment going " +
                "missing rather than a sign-in going stale - the amounts stand and the fetch carries on");

            return null;
        }

        throw ConnectorException.ProviderChanged(
            $"{DuoAdapter.ProviderId}: {call.Path} answered {reading.Status} from the portal's own services, " +
            $"in a run where {options.SessionPath} had already answered 200 and named a profile - so by DUO's " +
            "own account this session is alive and this call is missing something DUO's own page sends. " +
            "Reported as a changed provider rather than an expired session on purpose: DUO sets ForceAuthn, " +
            "another sign-in is a full DigiD authentication that Logius counts against the account holder, " +
            "and it would not fix this. The log line above says which headers the request carried.");
    }

    private static ConnectorException Unanswered(DuoReading reading, string path) =>
        ConnectorException.ProviderChanged(
            reading.Status is 0
                ? $"{DuoAdapter.ProviderId}: {path} never reached DUO, twice: {Quoted(reading.NotReached)}"
                : $"{DuoAdapter.ProviderId}: {path} answered {reading.Status} with " +
                  $"{reading.Body?.Length ?? 0} characters");

    // when a call never landed the url is the PAGE's: a move within DUO is recoverable, out to DigiD the session has ended
    private static bool Bounced(DuoReading reading, DuoOptions options) =>
        reading.Url.Contains(options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)
        || reading.Url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase);

    // one line per call, not per failure: faults were diagnosed from one agent-log line; sent shows what the 401 request carried
    // the PATH, not the url: a landing url after a bounce carries a SAMLRequest
    private static void Report(
        DuoReading reading, DuoOptions options, string path, Action<string>? note, bool again = false)
    {
        if (note is null) return;

        note(
            $"{DuoAdapter.ProviderId}: {path}{(again ? " (asked again)" : string.Empty)} -> {reading.Status}, " +
            $"{reading.Body?.Length ?? 0} chars" +
            (Bounced(reading, options) ? ", from the sign-in chain" : string.Empty) +
            (reading.Status is 0
                ? $", never landed: {Quoted(reading.NotReached)}; the page is now on {Where(reading.Url)}"
                : string.Empty) +
            (reading.Sent is { Count: > 0 } s ? $", sent [{string.Join(" ", s)}]" : string.Empty) +
            (reading.Headers is { Count: > 0 } h ? $", headers [{string.Join(" ", h)}]" : string.Empty));

        // the refusal quoted: a gateway usually says what was missing (DUO's 401 body is 163 characters nobody has read); capped
        // never for a call that never landed: DUO said nothing, and it would put the browser's complaint in the provider's mouth
        if (reading.Status is not 0 and (< 200 or > 299) && !string.IsNullOrWhiteSpace(reading.Body))
        {
            note($"{DuoAdapter.ProviderId}: {path} refused with: {Quoted(reading.Body)}");
        }
    }

    private static string Quoted(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "(nothing said)";

        var flat = text.ReplaceLineEndings(" ");

        return flat.Length > 300 ? flat[..300] : flat;
    }

    // path only: /isam/ vs /particulier/portaal/ says if DUO sent the browser to authenticate; the query holds a SAMLRequest
    private static string Where(string url)
    {
        var cut = url.IndexOfAny(['?', '#']);

        return cut < 0 ? url : url[..cut];
    }
}
