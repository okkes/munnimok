using System.Text.Json;

using Connector.Kit.Browsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Microsoft.Playwright;

namespace RegistryConnector.Adapters.Duo;

/// <summary>What one call to DUO's JSON API answered.</summary>
/// <param name="Status">The HTTP status.</param>
/// <param name="Url">
/// Where the response actually came from, AFTER redirects. This is the field
/// that tells a dead session apart from a rebuilt endpoint - a signed-out
/// visitor is bounced into the SAML chain, and the body that comes back is a
/// login page rather than an error.
/// </param>
/// <param name="Body">The text, whatever it turned out to be.</param>
/// <param name="Headers">
/// The response's header NAMES, lowercased. Names only, never values: a
/// response that mints a token carries it in one of these, and the name is the
/// diagnostic while the value is a credential.
/// </param>
/// <param name="Sent">
/// The header NAMES this request actually PRESENTED, captured before the fetch
/// went out. Names only, on the same rule as <paramref name="Headers"/>.
/// </param>
/// <param name="NotReached">
/// The browser's own words for why the call never left the page, and null when
/// it did leave. Set together with a <paramref name="Status"/> of 0.
/// </param>
/// <remarks>
/// <paramref name="Sent"/> is the half of the instrument two live runs on
/// 2026-09-20 were missing. Both notes could say what came back - the 200s
/// carried an <c>authorization</c> header and the 401 that ended each run
/// carried none - and neither could say whether the request that earned the
/// 401 had presented one. That is the question the whole diagnosis turned on,
/// and it was answered by inference rather than by the log.
/// </remarks>
internal readonly record struct DuoReading(
    int Status,
    string Url,
    string? Body,
    IReadOnlyList<string>? Headers = null,
    IReadOnlyList<string>? Sent = null,
    string? NotReached = null);

/// <summary>
/// The seam between "which endpoints to read" and "how to reach them".
///
/// Behind an interface for the same reason the login page is: the decisions
/// worth testing are which calls are made, which are allowed at all, and what a
/// bad answer means - none of which should need a browser and a citizen's DigiD
/// to exercise.
/// </summary>
internal interface IDuoPortal
{
    /// <summary>
    /// Puts the browser on a page, and answers where it ended up.
    /// </summary>
    /// <remarks>
    /// Required before anything is read, and not merely tidy. The reads below
    /// go through the page's own <c>fetch</c>, so they are same-origin only
    /// while the page IS on DUO - and a browser restored from a cookie jar
    /// starts on <c>about:blank</c>, from which every one of them is a
    /// cross-origin request that dies as <c>TypeError: Failed to fetch</c>.
    /// </remarks>
    Task<string> OpenAsync(string url, CancellationToken ct);

    /// <summary>
    /// Whether the browser LEAVES DUO for the sign-in chain within
    /// <paramref name="patience"/>.
    /// </summary>
    /// <remarks>
    /// The only question a url can honestly answer here, and it is the
    /// negative one. Sitting on a portal address proves nothing - opening
    /// <see cref="DuoOptions.StartUrl"/> lands on the dashboard and only THEN
    /// bounces into SAML - but leaving for <see cref="DuoOptions.LoginPathMarker"/>
    /// or <see cref="DuoOptions.LoginHostMarker"/> is something only a browser
    /// DUO has no session for ever does.
    /// <para>
    /// It lives on the portal rather than beside the login page because it is
    /// navigation, which is the half of this seam <see cref="OpenAsync"/>
    /// already is - and because the two witnesses to "is this profile still
    /// inside DUO" then answer from the same place.
    /// </para>
    /// </remarks>
    /// <returns>
    /// True when the browser left; false when it was still on DUO's own pages
    /// as the patience ran out, which is the answer a live session gives and
    /// the answer a slow bounce gives, and which is why nothing decides on
    /// this alone.
    /// </returns>
    Task<bool> BouncesToSignInAsync(TimeSpan patience, CancellationToken ct);

    Task<DuoReading> ReadAsync(string url, CancellationToken ct);

    /// <summary>
    /// What the page is made of, for the moment a step of the typed sign-in did
    /// not work.
    /// </summary>
    /// <remarks>
    /// The same probe ASN's pooled adapter attaches to every ConnectorException
    /// it raises, for the same reason and with the same redactions: selectors,
    /// roles and counts, no input values, no image bytes. This login runs on a
    /// citizen's real DigiD, which Logius counts failures against, so it cannot
    /// simply be repeated with more logging turned on - the diagnosis has to
    /// travel with the first failure.
    /// <para>
    /// It earns its place HERE more than anywhere else in this repository,
    /// because a DUO hand-over is about to stream this exact page to the
    /// account holder anyway. Whatever a shape could disclose, the human is
    /// already looking at; what it adds is that the operator reading the notes
    /// afterwards can see what they were looking at too.
    /// </para>
    /// <para>
    /// It lives on the portal rather than beside the login page for the reason
    /// <see cref="BouncesToSignInAsync"/> does: the page's own shape is a read
    /// through Playwright's evaluate, and <c>ILoginPage</c> is a seam about
    /// selectors. Both halves of "what happened" then answer from one place.
    /// </para>
    /// </remarks>
    Task<string> DescribeAsync(CancellationToken ct);
}

/// <summary>
/// DUO's JSON API, read from inside the signed-in page.
///
/// Through the page's own <c>fetch</c> rather than an HTTP client, because the
/// session IS the browser's cookie jar and this is the only way to use it
/// without copying those cookies anywhere. It is also exactly what the portal's
/// own single-page app does, from the same origin, so nothing here is a request
/// shape DUO does not already serve.
/// </summary>
internal sealed class PageDuoPortal(IPage page, DuoOptions options) : IDuoPortal
{
    /// <summary>
    /// Returns the status and the FINAL url as well as the body. A redirect
    /// into the sign-in chain is the shape a dead session takes here, and it
    /// arrives as a perfectly successful 200 carrying HTML - so a reader that
    /// only looked at the status would report DUO's login page as a debt
    /// summary that would not parse.
    /// </summary>
    /// <summary>
    /// Fetches inside DUO's own page, presenting the token DUO last handed it.
    /// </summary>
    /// <remarks>
    /// CONFIRMED live on 2026-08-11: every response from DUO's services
    /// carries an <c>authorization</c> header, and the <c>pfd</c> services
    /// answer 401 to a request that does not send it back. The session cookie
    /// alone satisfies <c>sessietoken/rest/jwt</c> and not them, which is why
    /// DUO managed to say "signed in" and "unauthorized" in the same second.
    /// <para>
    /// The token never crosses into this process. It is read from a response
    /// and put straight back on the next request, both inside the tab that was
    /// already holding the session - so a credential that DUO issued to that
    /// browser stays in that browser. Header NAMES come back for the log,
    /// because a name is a diagnostic and a value is a credential.
    /// </para>
    /// <para>
    /// THE CARRY LIVES IN THE ORIGIN'S SESSION STORE AND NOT ON <c>window</c>,
    /// and that one word is what two live runs on 2026-09-20 cost. Both ran
    /// against the real DUO on the account holder's own machine, and both died
    /// the same way with the middle of the sequence swapped: run A got 200s
    /// from <c>sessietoken/rest/jwt</c> and <c>mijn-schulden</c>, then
    /// <c>pfd/json/schulden</c> never landed at all - "TypeError: Failed to
    /// fetch", raised through DUO's own <c>polyfills</c> bundle - and every
    /// call after it answered 401 with no <c>authorization</c> header on the
    /// response. Run B got a 200 from that same <c>schulden</c> call and lost
    /// the NEXT one instead, this time with Playwright naming the mechanism
    /// outright: "Execution context was destroyed, most likely because of a
    /// navigation". So the call that dies is not a particular endpoint; what
    /// is constant is that DUO's page navigates mid-sequence, and everything
    /// after the navigation is unauthorized.
    /// </para>
    /// <para>
    /// A navigation destroys <c>window</c>, so a carry parked there is the
    /// token DUO issued being thrown away at exactly the moment the page
    /// moves. <c>sessionStorage</c> keeps the same promise the paragraph above
    /// makes and keeps it across that: it is partitioned BY ORIGIN, so a value
    /// minted by <c>mijn.duo.nl</c> is readable only by <c>mijn.duo.nl</c>
    /// pages - which is stricter than <c>window.__duoCarry</c> ever was, not
    /// looser - it survives same-origin navigations in the tab, and it dies
    /// with the tab, so the token never becomes a stored secret anybody has to
    /// look after. <c>window.name</c> would also survive, and survives
    /// CROSS-origin navigations too; that is precisely why it is refused here,
    /// because surviving into <c>login.digid.nl</c> means handing DUO's
    /// credential to DigiD.
    /// </para>
    /// <para>
    /// If the navigation IS cross-origin - into the SAML chain - the store is
    /// unreachable from the page that lands, and nothing here can help: a
    /// fetch at DUO's services from DigiD's origin is refused by the browser
    /// before the token would matter. That case is not a lost token, it is a
    /// dead session, and it is already read as one - see <c>DuoCalls</c>,
    /// which checks where the browser ended up before it retries anything. The
    /// store is still intact behind that origin, and a browser that comes back
    /// to <c>mijn.duo.nl</c> finds it again.
    /// </para>
    /// <para>
    /// The <c>window</c> copy is kept as a fallback rather than deleted,
    /// because <c>sessionStorage</c> can throw outright where site data is
    /// blocked or the document is on an opaque origin. Where it throws, this
    /// is exactly the behaviour that shipped before; where it does not, the
    /// token outlives the page.
    /// </para>
    /// <para>
    /// Internal rather than private only so a test can hold it to the store it
    /// names. Nothing but Chromium can RUN this, so the one property worth
    /// pinning offline is the property a live run had to teach us: that the
    /// carry is not parked somewhere a navigation deletes.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// Where the carry is kept, under a name that is unmistakably ours.
    /// </summary>
    /// <remarks>
    /// DUO's own single-page app uses this store too, and writing under a key
    /// it happens to use would corrupt the portal the fetch is running inside.
    /// Not in <see cref="DuoOptions"/> with the rest of the strings, because
    /// everything there is a name DUO could rename and this one is not: it is
    /// this connector's own key in this connector's own store.
    /// </remarks>
    internal const string CarryKey = "__connector_duo_carry";

    public async Task<string> OpenAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        await page.GotoAsync(url).ConfigureAwait(false);

        return page.Url;
    }

    public async Task<bool> BouncesToSignInAsync(TimeSpan patience, CancellationToken ct)
    {
        // Before the wait exists, so an already-cancelled job leaves nothing
        // running in the driver.
        //
        // And that is the whole of the cancellation story here, unlike the
        // bank's equivalent wait: Playwright's waits take a timeout and
        // nothing else, so a token arriving mid-wait cannot end one. On ASN
        // that mattered, because the wait there is twelve minutes of somebody
        // registering a browser at their bank. This one is bounded by
        // DuoOptions.SignedOutBounceSeconds, so the worst a lost lease buys is
        // that window, once, on a job that is already over.
        ct.ThrowIfCancellationRequested();

        try
        {
            // THE SAME PREDICATE THE REST OF THIS ADAPTER SETTLES ON, negated.
            // A second opinion about what "signed in" means is how two checks
            // start disagreeing about one browser.
            await page.WaitForURLAsync(
                    url => !DuoSignedInWatcher.SignedIn(url, options),
                    new PageWaitForURLOptions { Timeout = (float)patience.TotalMilliseconds })
                .ConfigureAwait(false);

            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // Still on DUO's own pages when the patience ran out. That is what
            // a live session looks like - and also what a bounce that landed
            // but was slow to finish loading looks like, because Playwright's
            // url wait matches the address and then waits for the load event
            // on the same clock. Both go on to DUO's session endpoint, which
            // is the witness that cannot be wrong about this, so the two need
            // not be told apart here.
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
            // A call that could not be made at all: the page navigated under
            // us, or it is not on DUO's origin so the browser refused the
            // request outright. Reported as a reading with no status rather
            // than thrown, so the one place that decides what an answer MEANS
            // stays the one place - see DuoCalls.
            //
            // Thrown, this arrived at a user as "something broke on our side,
            // HTTP 500", which is both unhelpful and untrue: nothing broke
            // here, we simply never reached DUO.
            //
            // THE BROWSER'S OWN WORDS, and in their own field rather than
            // stuffed into the body. The body is what DUO said, and DUO said
            // nothing here - a message in it reads downstream as a refusal
            // with a reason in it and is logged as "refused with", which is
            // the opposite of what happened. On 2026-09-20 these were the two
            // sentences the whole diagnosis rested on: "TypeError: Failed to
            // fetch" in run A and "Execution context was destroyed, most
            // likely because of a navigation" in run B.
            //
            // The url is where the PAGE is now, which is the other half of
            // that answer - a navigation into the SAML chain is a dead session
            // and a navigation within DUO is not.
            return new DuoReading(0, page.Url, null, NotReached: ex.Message);
        }

        return new DuoReading(
            answer.Int32("status") ?? 0,
            answer.Text("url") ?? url,

            // Untrimmed, unlike everything else read here: this is the response
            // itself, and a parser downstream is entitled to the bytes the
            // provider sent rather than a tidied copy of them.
            answer.Child("body") is { ValueKind: JsonValueKind.String } body ? body.GetString() : null,
            Names(answer, "headers"),

            // What this request PRESENTED, per call rather than as a running
            // total on the portal. The running total answered a question
            // nobody was asking: it said which headers had ever been carried,
            // not which THIS call went out with, and the call that gets the
            // 401 is the only one that matters.
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
            // A page that cannot be described is not a failure. This is only
            // ever called because something else has already gone wrong, and
            // the caller is on its way to hand the page to a human either way -
            // so the honest thing is to say the probe missed and let the
            // hand-over run. Which is exactly what it must do: the two live
            // failures of this tier were both a second exception escaping the
            // diagnosis path and taking the hand-over down with it.
            return $"the page could not be described ({ex.GetType().Name})";
        }
    }

    private static List<string> Names(JsonElement answer, string property) =>
        [.. answer.Items(property).Select(n => n.Text()).Where(n => n is not null).Select(n => n!)];
}

/// <summary>
/// Whether DUO thinks anybody is signed in.
///
/// A URL cannot answer this, which is the whole reason this exists. Opening
/// <c>mijn.duo.nl</c> redirects to <c>/particulier/portaal/dashboard</c> and
/// only THEN bounces into SAML, so there is a window - short, but the first
/// thing a watcher sees - where the browser is sitting on the portal's own
/// address while signed out. Reading that address reports a finished login
/// before DigiD has been shown to anybody.
///
/// That is not a hypothetical. It shipped: the live view opened and the login
/// reported success 80 milliseconds later, having asked the human for nothing.
/// The fix is to stop inferring and ask DUO, which is the same correction
/// Coolblue forced when an anonymous cookie was sealed as a real session.
/// </summary>
internal static class DuoSession
{
    /// <summary>
    /// True when the payload names whose session it is.
    /// </summary>
    /// <remarks>
    /// Deliberately strict about the shape and uninterested in the value: a
    /// signed-out visitor gets a redirect into the sign-in chain and a page of
    /// HTML, so anything that is not an object carrying the profile field is a
    /// no. The value itself is never read - it is DUO's own classification of
    /// the account holder, and this only needs to know that DUO named one.
    /// </remarks>
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

/// <summary>One call to DUO's JSON API, as this connector understands it.</summary>
/// <param name="Path">The endpoint, relative to <see cref="DuoOptions.ServicesRoot"/>.</param>
/// <param name="Required">
/// Whether the fetch is lost without it. Enrichment is allowed to be missing:
/// the amounts are the point of the fetch, and losing an interest rate should
/// never cost somebody their balance.
/// </param>
/// <param name="Dossier">
/// Whether this is the one call allowed to read the customer dossier. See
/// <see cref="DuoCalls.ReadAsync"/> for the refusal that stands for every
/// other read.
/// </param>
/// <param name="SessionConfirmed">
/// Whether DUO's own session endpoint has already answered in THIS run and
/// named a profile.
/// </param>
internal readonly record struct DuoCall(
    string Path,
    bool Required,
    bool Dossier = false,
    bool SessionConfirmed = false);

/// <summary>
/// What this connector is allowed to ask DUO for, and what an answer means.
/// </summary>
internal static class DuoCalls
{
    /// <summary>
    /// Reads one endpoint, refusing outright to read the one that must never
    /// be read.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// The URL is the customer dossier. NOT a
    /// <see cref="ConnectorException"/>: a connector exception is a thing that
    /// went wrong with a provider, and this is a bug in this repository - code
    /// asking for 2.5 MB of somebody's BSN, both parents, twenty years of
    /// income, IBANs and addresses in order to render a debt figure. The rule
    /// lives here as code rather than as a paragraph in a design document
    /// precisely so that it cannot be forgotten by whoever adds the fourth
    /// endpoint.
    /// </exception>
    /// <param name="call">
    /// Which endpoint, and what this run already knows about it - see
    /// <see cref="DuoCall"/>.
    /// </param>
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

        // A CALL A NAVIGATION KILLED DID NOT FAIL - IT WAS INTERRUPTED.
        //
        // Two live runs on 2026-09-20 each lost exactly one call this way and
        // then reported the session as dead. Run A: "TypeError: Failed to
        // fetch" on pfd/json/schulden. Run B: that same call answered 200 and
        // the next one died with Playwright's own diagnosis, "Execution
        // context was destroyed, most likely because of a navigation". DUO's
        // page moved under the fetch sequence; nothing here navigates between
        // these calls.
        //
        // The distinction that makes retrying safe is not "is this error
        // transient" but "did the request reach DUO at all". A status of 0
        // means it did not: no request was served, nothing was booked, nothing
        // was rate-limited, and every call here is a GET in any case. Asking
        // again costs DUO one request and the account holder nothing.
        //
        // ONCE, AND THE BOUND IS WHERE IT IS ON PURPOSE. The first retry wins
        // the ordinary case, because the navigation has landed by then and the
        // token came back out of the origin's session store with it. A second
        // interruption of the same call means the page is still moving, and a
        // loop would be this adapter racing a redirect on a job that is
        // already spending somebody's DigiD - so the second reading is
        // reported, whatever it says. Where the page moved INTO the sign-in
        // chain there is no retry at all: that is not a lost token, it is a
        // session that ended, and the check below reads it as one.
        if (reading.Status is 0 && !Bounced(reading, options))
        {
            reading = await portal.ReadAsync(url, ct).ConfigureAwait(false);

            Report(reading, options, call.Path, note, again: true);
        }

        // Checked before the body, because a dead session and a rebuilt
        // endpoint BOTH arrive as "this is not the JSON I expected" and they
        // call for opposite responses: one needs a sign-in button, the other
        // needs an engineer. Only the status and the landing url tell them
        // apart.
        //
        // STILL UNCONFIRMED, and marked so rather than dressed up: no session
        // has ever been observed expiring, across two live captures and four
        // live runs. What the runs of 2026-09-20 did settle is the negative -
        // a refusal is NOT an expiry when DUO has just named the profile - so
        // the bounce below is now the only shape this connector is willing to
        // call an expiry on its own evidence, and everything else that could
        // be one has to say why.
        //
        // TWO DIFFERENT THINGS, and they were sharing one sentence.
        //
        // The message used to say "which is the sign-in chain rather than the
        // portal" for both - and said it about a 401 that came back from the
        // portal's own services url, with DUO's session endpoint answering 200
        // beside it. An error that asserts something the log contradicts is
        // worse than a vague one: it sends the next reader looking in the
        // wrong place.
        if (Bounced(reading, options)) throw SessionOver(reading, call.Path);

        // A REFUSAL AFTER DUO HAS NAMED THE PROFILE IS NOT A DEAD SESSION, and
        // reporting it as one is what cost the account holder four DigiD
        // sign-ins on 2026-09-20.
        //
        // In both runs that day sessietoken/rest/jwt answered 200 with
        // {"profiel":"PP",...} and two or three data calls answered 200 with
        // real figures before anything refused. Then a navigation destroyed
        // the carried token and the rest of the sequence came back 401 - with
        // no authorization header on the response, which is exactly what a
        // request that presented none earns. Calling that "the session
        // expired" contradicts the provider's own account of itself in the
        // same second, and the contradiction is expensive rather than merely
        // untidy: DUO sets ForceAuthn, so every "sign in again" is a full
        // DigiD authentication that Logius counts against the citizen whose
        // account it is.
        //
        // ProviderChanged rather than SessionExpired, from the catalogue's own
        // terms: SessionExpired tells the consumer Reauth, which is the one
        // instruction that is both wrong and costly here. ProviderChanged
        // tells it to wait and pages an operator, which is the truth - this
        // call is missing something DUO's own page sends, and no amount of
        // signing in again supplies it.
        if (reading.Status is 401 or 403 && call.SessionConfirmed)
        {
            return RefusedAfterConfirmation(reading, options, call, note);
        }

        if (reading.Status is 401 or 403)
        {
            // No session endpoint has answered in this run, so today's reading
            // may well be right: a browser whose session really has ended gets
            // refused exactly like this. Kept honest rather than kept quiet -
            // this is the path the session call itself takes.
            throw ConnectorException.SessionExpired(
                $"{DuoAdapter.ProviderId}: {call.Path} answered {reading.Status} from the portal's own services, and " +
                "nothing has confirmed a session in this run. Whether that means the session is over or that " +
                "this call is missing something DUO's own page sends, the log line above quotes DUO's answer " +
                "verbatim.");
        }

        if (reading.Status is < 200 or > 299 || string.IsNullOrWhiteSpace(reading.Body))
        {
            // Enrichment is allowed to be missing. The amounts are the point
            // of the fetch, and losing an interest rate should never cost
            // somebody their balance.
            if (!call.Required) return null;

            throw Unanswered(reading, call.Path);
        }

        return reading.Body;
    }

    /// <summary>
    /// The refusal that stands for every ordinary read.
    /// </summary>
    private static void RefuseDossier(string url, DuoOptions options, bool dossier)
    {
        // The refusal still stands for every ordinary read, and `dossier` is
        // the only way past it. Not a flag somebody can pass casually: the one
        // call site that sets it is guarded by the caller having asked for the
        // ledger, which nothing does by default, and the reader it feeds takes
        // the movements and one instalment out of the payload and touches
        // nothing else in it.
        if (!dossier && url.Contains(options.ForbiddenPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"{DuoAdapter.ProviderId}: '{options.ForbiddenPath}' is the customer dossier and this connector " +
                "must never call it. It answers with a BSN, both parents, a partner, twenty years of tax income, " +
                "IBANs and every address the account holder has lived at. Whatever field was wanted from it, the " +
                "answer is to do without - see the note on StudentDebt for the one this connector already forgoes.");
        }
    }

    /// <summary>
    /// The session that is over, worded for how this call met it.
    /// </summary>
    private static ConnectorException SessionOver(DuoReading reading, string path)
    {
        // TWO WAYS TO ARRIVE HERE AND ONLY ONE OF THEM IS AN ANSWER. The
        // old one is a 200 served BY the sign-in chain. The new one is a
        // call that never landed because the page navigated out to DigiD
        // mid-fetch, where the url is the page's rather than a response's
        // - and saying that call "was answered" would put words in DUO's
        // mouth for a request DUO never saw.
        return ConnectorException.SessionExpired(
            reading.Status is 0
                ? $"{DuoAdapter.ProviderId}: {path} never landed, because the page left for the sign-in " +
                  "chain while the call was in flight - so the stored session is over. DUO sets ForceAuthn, " +
                  "so this needs a new DigiD sign-in and there is nothing to refresh."
                : $"{DuoAdapter.ProviderId}: {path} was answered from the sign-in chain rather than the " +
                  "portal, so the stored session is over. DUO sets ForceAuthn, so this needs a new DigiD " +
                  "sign-in and there is nothing to refresh.");
    }

    /// <summary>
    /// A refusal from the portal's own services in a run where DUO has already
    /// named the profile: nothing, for enrichment; a changed provider, for a
    /// call the fetch cannot do without.
    /// </summary>
    private static string? RefusedAfterConfirmation(
        DuoReading reading, DuoOptions options, DuoCall call, Action<string>? note)
    {
        // And an enrichment call that is refused costs the enrichment and
        // nothing else, which is the rule this file already keeps for
        // every other bad status and which a special case for 401 was
        // routing around. Both of the failed runs died on an OPTIONAL call
        // - the payment holiday in run A, the balance history in run B -
        // with the required amounts already in hand at 200. Under this
        // rule those runs end with the account holder's debt on their
        // screen and one line missing from it.
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

    /// <summary>
    /// A call the fetch cannot do without, which DUO did not answer.
    /// </summary>
    private static ConnectorException Unanswered(DuoReading reading, string path) =>
        ConnectorException.ProviderChanged(
            reading.Status is 0
                ? $"{DuoAdapter.ProviderId}: {path} never reached DUO, twice: {Quoted(reading.NotReached)}"
                : $"{DuoAdapter.ProviderId}: {path} answered {reading.Status} with " +
                  $"{reading.Body?.Length ?? 0} characters");

    /// <summary>
    /// Whether this answer came from the sign-in chain rather than the portal.
    /// </summary>
    /// <remarks>
    /// For a call that never landed the url is where the PAGE is, not where a
    /// response came from, and that is deliberate: it is the one observation
    /// that tells a navigation within DUO - which costs a token and is
    /// recoverable - apart from a navigation out to DigiD, which is a session
    /// that has ended.
    /// </remarks>
    private static bool Bounced(DuoReading reading, DuoOptions options) =>
        reading.Url.Contains(options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)
        || reading.Url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// One line per call, not just per failure.
    /// </summary>
    /// <remarks>
    /// Four separate faults in this adapter have each been diagnosed from a
    /// single line of agent log, and every time the question was the same one:
    /// which call, and what did it answer. The fourth - the two runs of
    /// 2026-09-20 - added a question these lines could not answer, which is
    /// why <c>sent</c> is here: the notes could say that the 401 came back
    /// without an <c>authorization</c> header and not whether the request that
    /// earned it had presented one.
    /// <para>
    /// The PATH and not the url. A landing url after a bounce carries a
    /// SAMLRequest, and an operator log is not the place for one.
    /// </para>
    /// </remarks>
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

        // The refusal itself, quoted.
        //
        // A gateway that refuses a call usually says what was missing, and
        // that sentence is the difference between another live sign-in and an
        // answer: DUO answered this 401 with 163 characters that nobody has
        // ever read. It is an error message rather than data - the account
        // holder's figures come back on a 200 - and it is capped so a page of
        // HTML cannot land in an operator's terminal.
        //
        // Never for a call that never landed. DUO said nothing there, and
        // "refused with" would put the browser's own complaint in the
        // provider's mouth.
        if (reading.Status is not 0 and (< 200 or > 299) && !string.IsNullOrWhiteSpace(reading.Body))
        {
            note($"{DuoAdapter.ProviderId}: {path} refused with: {Quoted(reading.Body)}");
        }
    }

    /// <summary>Flattened and capped, so nothing empties a page into a terminal.</summary>
    private static string Quoted(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "(nothing said)";

        var flat = text.ReplaceLineEndings(" ");

        return flat.Length > 300 ? flat[..300] : flat;
    }

    /// <summary>
    /// Where the browser ended up, with the query taken off.
    /// </summary>
    /// <remarks>
    /// The path is the diagnostic - <c>/isam/…</c> against
    /// <c>/particulier/portaal/…</c> answers "did DUO send this browser to
    /// authenticate, or did its own page simply move" - and the query is where
    /// a SAMLRequest and a RelayState live. So the query and the fragment are
    /// cut, and what is left is scheme, host and path.
    /// </remarks>
    private static string Where(string url)
    {
        var cut = url.IndexOfAny(['?', '#']);

        return cut < 0 ? url : url[..cut];
    }
}
