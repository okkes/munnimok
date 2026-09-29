# DUO (Dienst Uitvoering Onderwijs) — how the login and the data actually work

Status: **captured live over three sessions, BUILT, and VERIFIED END TO END on
2026-08-11 against the account holder's own DigiD.** THREE authenticated
captures with the account holder driving — one by sms, one by the DigiD app, one
aimed at the pages the first two never opened — so both login methods and the
data are settled. Everything marked CONFIRMED comes from those sessions;
everything marked UNKNOWN is still unknown and must not be guessed at.

**Checked against DUO's own screen**: the figure the connector emits is the
figure its *Saldo schuld* panel shows, to the cent. The amount itself is
deliberately not written down here — it is the account holder's, the claim is
about agreement rather than about the number, and this file is committed.

The total is still `total_is_derived`: DUO publishes no total anywhere, so it is
our sum. On this account one component is non-zero so the sum cannot be wrong.
**An account with two or more non-zero components has never been compared**, and
that is the case where a derived total could disagree with what DUO shows.

The adapter is `registry-connector/src/RegistryConnector.Adapters/Duo`. Every
capture has been **deleted**, and redacted fixtures built from them live in
`Fixtures/duo`. See [What was built](#what-was-built) for what the captures
changed about the plan, which is more than they left alone.

**The as-of date IS emitted, and an earlier version of this file argued at
length that it never could be.** See [the correction](#the-as-of-date--wrong-below-and-corrected-here).

**DUO is `AgentClass.Pooled` since 2026-09-21, and this run concluded `Byo`.**
The reasoning below is unchanged and is still what would reverse it; what it
did not know is that nothing enforced it, and that a fleet of one container on
the account holder's own connection is not the shared egress it is about. See
[What was built](#what-was-built).

---

## The one finding that changes the design

`GET /particulier/services/pfd/json/raadplegen/klantbeeld` returns **2.5 MB
containing the account holder's entire government dossier**, and the portal
calls it to draw a debt page.

Observed in it, in one response:

| | |
| --- | --- |
| Identity | `burgerserviceNummer`, `geboortedatum`, `geboorteplaats`, `geboorteland`, `geslacht`, `geslachtsnaam`, `voornamen`, `geheimhoudingscode`, `nationaliteits[]` |
| Family | `ouders[]` — both parents, names and dates of birth; `partners[]` — name, date of birth, date of marriage |
| Money | `inkomens[20]` — twenty years of tax income; `rekenings[]` — IBAN and BIC; `betalingsachterstands[]` |
| Where | `woonAdres[4]` — current and historical addresses |
| Study | `onderwijsovereenkomsts[]` — institutions, enrolment and de-enrolment dates |
| Volume | `vorderingmutaties[1223]`, `uitgaves[865]`, `verplichtings[625]`, `posts[147]`, `grondslaggegevens[2512]` |

**No adapter may call this endpoint.** Not to read one field out of it, not
"and discard the rest": a connector whose entire proposition is minimal custody
cannot pull a BSN, both parents and twenty years of income into its own process
to render a debt figure. The narrow endpoints below exist and are enough.

That is a rule about *our* code. DUO's own portal does call it - which is why
the as-of date below is a loss this connector accepts rather than a gap it can
close.

**The rule is now code rather than prose.** `DuoCalls.ReadAsync` refuses any URL
containing `raadplegen/klantbeeld` before a request is sent, and throws an
`InvalidOperationException` rather than a `ConnectorException` - because a
connector exception means a provider did something, and this would be our own
code asking for what it must not. A paragraph in a design document cannot stop
whoever adds the fourth endpoint; a throw can.

---

## The login chain — CONFIRMED

Start at the protected page and let DUO's own redirects drive. This is the same
correction Coolblue forced on 2026-08-07: hand-crafting an identity provider's
entry URL is how a login succeeds at the IdP and leaves the site signed out.

1. `https://mijn.duo.nl/` → 302 → `/particulier/portaal/dashboard` → SAML:

   ```
   mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial
     ?NameIdFormat=Transient
     &Target=https://mijn.duo.nl:443/particulier/portaal/dashboard
     &ForceAuthn=true
     &RequestBinding=HTTPPost
     &AuthnContextClassRef=urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport
     &AuthnContextComparison=minimum
   ```

   **`ForceAuthn=true` — CONFIRMED**, as predicted. Every sync needs the human.
   `AuthnContextComparison=minimum` against *PasswordProtectedTransport* means
   DUO asks for DigiD's lowest assurance level, so **which method is used is the
   user's choice, not DUO's**.

2. **A fork nobody predicted, and it comes before DigiD**: DUO's own WAYF asks
   *who you are signing in as*.

   | Radio | id | Label |
   | --- | --- | --- |
   | `ITFIM_WAYF_IDP` | `ITFIM_WAYF_IDP_0` | Voor mijzelf |
   | `ITFIM_WAYF_IDP` | `ITFIM_WAYF_IDP_1` | Als gemachtigde |

   Submitted as `ITFIM_WAYF_IDP=urn:nl-eid-gdi:…`. An adapter must choose
   **Voor mijzelf** explicitly rather than accept a default — *als gemachtigde*
   is signing in on somebody else's behalf, and picking it by accident would
   fetch a different person's debt.

3. → `login.digid.nl/saml/v4/entrance/request_authentication`
   (POST: `RelayState`, `SAMLRequest`)

4. → `login.digid.nl/inloggen` — **"Hoe wilt u inloggen?"**, and there are
   **four** methods, not the two the research assumed:

   - Met de DigiD app — *"De makkelijkste manier om veilig in te loggen"*
   - Met een sms-controle
   - Met mijn rijbewijs
   - Met mijn identiteitskaart

   The last two need an NFC document reader and are out of scope for any
   automated browser. The manifest offers `app` and `sms` and should say so.

   POST field names: `utf8`, `authenticity_token`,
   `authentication[type_account]`, `authentication[username]`, …
   — the method travels as `authentication[type_account]`.

5. → `login.digid.nl/inloggen_sms` — username and password, on one screen:

   | Field | name | id |
   | --- | --- | --- |
   | DigiD gebruikersnaam | `authentication[username]` | `authentication_username` |
   | Wachtwoord | `authentication[password]` | `authentication_password` |
   | Onthoud mijn gebruikersnaam | `authentication[remember_login]` | `authentication_remember_login` |
   | submit | `commit` | `submit-button` |

6. → `login.digid.nl/sms_controleren` — the code, as **six separate
   single-digit inputs**: `#smscode_smscode_field_0` … `_5`, each
   `type=number maxlength=1`. Submit is `#submit-button`, cancel
   `#cancel-button`.

   The POST goes to `login.digid.nl/bevestig_telefoonnummer` carrying a
   **single** field, `smscode[smscode]` — so the six boxes are presentation.
   An adapter still has to fill six of them.

7. → `https://mijn.duo.nl/particulier/portaal/dashboard`.
   Sign-out is `mijn.duo.nl/pkmslogout`.

### The DigiD app path — CONFIRMED, second capture 2026-08-10

Captured on its own run. The account holder's description was **exactly right**,
including the part that contradicted DigiD's public documentation: the app shows
a code, the code is typed into the browser, and only then does the browser show
a QR to scan.

| Step | URL | What it is |
| --- | --- | --- |
| 1 | `login.digid.nl/inloggen` | method choice |
| 2 | `login.digid.nl/inloggen_app` | **the app's code is typed here** — DigiD's own background asset for this screen is called `backgrounds/koppelcode` |
| 3 | `login.digid.nl/inloggen_app_qr?utf8=✓&app_verification_code[verification_code]=XXXX&button=` | **the QR is shown** — note the code travels as a GET parameter |
| 4 | `login.digid.nl/inloggen_app_poll?_=<ms>` | the page LONG-POLLS, waiting for the phone |
| 5 | `login.digid.nl/inloggen_app_confirm` | approved |
| 6 | `login.digid.nl/saml/v4/idp/redirect_with_artifact?SAMLart=…` | back to DUO |

Step 4 matters to an adapter as much as the QR does: the browser must be left on
that page while the human reaches for their phone. Navigating away, or treating
a still screen as a stalled login, breaks a flow that is working.

### How the QR is drawn — CONFIRMED, and it is the best possible answer

```html
<img style="display: block;" src="data:image/png;base64,…">
```

A **196×196 PNG, inline in the markup**, inside `#app_verification_code.qr_code`.
Decoded from the captured page: 2958 bytes, magic `89504e47`.

So the exact bytes DigiD produced are **already in the DOM**. Nothing has to be
screenshotted, cropped, scaled or re-encoded — an adapter reads the `src`
attribute and relays that PNG verbatim. Lossless by construction rather than by
care, which retires the concern that motivated this whole second capture: the
live view's JPEG stream at quality 60 fails to decode about **1.5%** of QR
codes, and none of that applies to bytes that are never re-encoded.

A cropped screenshot was taken as well and is also clean and scannable, so the
`QrDisplay` relay would work either way. The data URI is simply strictly better.

**There are THREE images in that block and only one is the code.** Re-reading
the captured `outerHTML` while building the adapter turned up two more than the
first pass reported:

| Element | Size | Source |
| --- | --- | --- |
| `img.digid-qr-code-logo` | 44×44 | `/assets/digid_eo_rgb-….svg` — the LOGO, and it is FIRST |
| `img` inside `<noscript>` | — | `login.digid.nl/qr_code?data=…` — a remote copy for scripting-off |
| `canvas` | 196×196 | `display:none` — where the code is DRAWN before being exported |
| `img` (no class) | 196×196 | `data:image/png;base64,…` — the QR |

An adapter must select on `src^="data:image"` rather than on position or on the
`qr_code` container's first image, or it will relay a 44-pixel DigiD logo to
somebody's phone and wait forever for a scan that cannot happen.

### The block also states the payload in plain text — CONFIRMED

Not spotted on the first pass. `#app_verification_code` carries the QR's
contents twice over, as ordinary attributes:

```
data-code="digid-app-auth://app_session_id=…&lb=&at=…&host=digid.nl"
text="digid-app-auth://app_session_id=…&lb=&at=…&host=digid.nl"
```

That is the deep link the DigiD app opens, verbatim - the same thing the picture
encodes. The adapter relays it in the challenge's `Url` beside the image, for a
case a picture cannot serve at all: **somebody connecting from the phone itself
cannot photograph the screen they are reading the QR from.** A consumer running
there can offer a tap instead.

One thing this exposes, noted rather than acted on: `Challenge.IsPassive` covers
`AppApproval` and `LiveView` but not `QrDisplay`, so a consumer will draw a text
box under a QR that has nothing to type back. The adapter does not depend on it -
it never reads the answer, and what ends the login is the browser reaching the
portal - but the vocabulary is wrong and the first real `QrDisplay` is what made
that visible.

### What is still unknown about the QR

**Whether it expires or rotates.** The captured session went from QR to scan in
about six seconds, and in that window DigiD refreshed nothing: one
`/inloggen_app_qr`, no repeat. A relay that hands a user a still image needs to
know whether that image goes stale, and this capture cannot say. Assume it does,
and re-read the `src` on a timer, until somebody observes otherwise.

---

## The data — CONFIRMED

`mijn.duo.nl` is a Knockout SPA with hash routing
(`/particulier/portaal/klantportaal/klantportaal/mijn.html#/mijn-schulden`) over
a **real JSON API**. Nothing here needs markup parsed, which makes DUO the
opposite of Coolblue.

Everything below is under `https://mijn.duo.nl/particulier/services/`.

### What an adapter should call

| Endpoint | Size | Carries |
| --- | --- | --- |
| `sessietoken/rest/jwt` | 99 B | `{profiel, nieuwToken, timeout, isGemachtigd}` — **and the token, in a header** |
| `pfd/json/raadplegen/mijn-schulden` | 346 B | the eight debt components |
| `pfd/json/schulden` | 354 B | status and the interest-rate periods |
| `pfd/json/raadplegen/resterend-aantal-maanden-aflosvrij?peildatum=…` | 38 B | months of payment holiday left |
| `mijn-schulden/rest/mijnschuld` | 114 B | four headline figures — not called, see below |
| `pfd/json/raadplegen/aflosvrijeperiode` | 26 B | the payment holiday, or null — not called |

### The cookie is not enough — CONFIRMED 2026-08-11

This cost four live sign-ins to understand, so it is worth stating flatly.

**Every response from `mijn.duo.nl/particulier/services/` carries an
`authorization` header, and the `pfd` services answer 401 to a request that
does not send it back.** The session cookie alone satisfies
`sessietoken/rest/jwt` and does not satisfy them — which is why DUO managed to
say *signed in* and *unauthorized* in the same second:

```
sessietoken/rest/jwt              -> 200, 99 chars
pfd/json/raadplegen/mijn-schulden -> 401
```

So a reader must call the session endpoint first — which is what the portal's
own dashboard does, before every other service call — and present the
`authorization` header it hands back on everything after it. The adapter keeps
that value inside the browser tab and never lets it into its own process.

### `peildatum` is required, and its absence is silent — CONFIRMED

`resterend-aantal-maanden-aflosvrij` takes a reference date and refuses
without one:

```json
{"detail":"Required parameter 'peildatum' is not present.","status":400}
```

Worth recording as a research failure rather than a provider quirk: the first
build missed it because the capture's URLs were mapped with the query string
stripped off. The endpoint 400'd on every fetch, the payment holiday was
silently absent from the record, and nothing said so until the refusal body was
quoted into the log. DUO's own portal passes today.

`raadplegen/mijn-schulden` — eight sibling amounts, one per debt kind:

```
schuldbedragLening                                schuldbedragPrestatiebeurs
schuldbedragLevenlanglerenkrediet                 schuldbedragTeveelBijverdiensten
schuldbedragOVSchuld                              schuldbedragTeveelOntvangenLevenlanglerenkrediet
schuldbedragTeveelOntvangenStudiefinanciering     schuldbedragTeveelOntvangenTegemoetkomingScholier
```

`pfd/json/schulden` — an array, one entry per debt:

```
statusSchuld                 e.g. "TERUGBETAALPERIODE"
indicatieLevenlanglerenkrediet
beslissenId
overstapmogelijkheid
rentepercentagePeriodes[] { vorderingsregime, startdatum, einddatum, rentepercentage }
```

**The money's unit is SETTLED: euros, as a JSON number, to eight decimal
places.** Read off the capture before anything was built, which is the only way
this platform allows a unit to be decided. It is a Java `BigDecimal` on the
wire, and that carries a hazard worth more than the unit itself:

> **zero arrives as `0E-8`.**

That is a legal JSON number and `JsonElement.GetDecimal()` reads it fine. It
does **not** parse under the `NumberStyles` `MoneyParser`'s string overload
uses, which deliberately excludes exponents. So the reader takes the decimal off
the reader and never round-trips an amount through text. Seven of the eight
components are zero for almost everybody, so getting this wrong would have
failed on nearly every account rather than on an unlucky one — the kind of bug
that looks like a broken provider.

### The interest rate is reproducible without the dossier — CONFIRMED

`bepaalRenteVanSchuldInOpbouw`, in DUO's own `mijn-schulden-opbouw-mapper.js`,
takes `pfd/json/schulden` — a narrow endpoint — and nothing else:

```js
r = _.find(e.rentepercentagePeriodes,
      AND(startdatum <= now, einddatum >= now));
return { huidigVorderingsregime: r.vorderingsregime,
         huidigRentepercentage: r.rentepercentage, … }
```

So "the rate in force today" is the period whose window contains the day, and
the adapter resolves it exactly that way. Unlike the as-of date, this one costs
nothing to state.

### The labels the portal itself uses

From `klantportaal/templates/mijn-schulden/…`, which are static templates and
carry no personal data:

- *Saldo schuld*, *Saldo aflossingen*, *Saldo achterstand*
- ***rente is berekend tot*** — the as-of date, rendered next to the balance
- *U heeft uw studieschuld volledig afgelost*
- *Totaal direct inbare schulden*, *Ov-schuld*,
  *Te veel ontvangen studiefinanciering*, *Schuld wegens te veel bijverdiensten*

---

## The as-of date — WRONG BELOW, and corrected here

**Everything in the section that follows was mistaken, and it is left standing
because how it was wrong matters more than what it concluded.**

`GET pfd/json/raadplegen/schuldhistorie` is 5.6 KB, narrow, and its first entry
is:

```json
{"@type":"SaldoActueel","renteBerekendTot":"2026-08-01",
 "saldoInclusiefRente":<balance>,"saldoRentedeel":<interest>,"rentepercentage":2.57}
```

That is the date. No BSN, no parents, no income — nothing this connector had
been refusing to read.

The claim below says "every narrow endpoint in both captures was checked; not
one carries the field." That sentence is TRUE and the conclusion drawn from it
is not. Both captures recorded the endpoints the account holder's browsing
happened to call, and nobody had opened *Mijn schuldhistorie* — so the endpoint
was never in the evidence. "Every endpoint I have seen" was written as "every
endpoint that exists", and a design decision was built on the difference,
argued at length, and shipped: `StudentDebt` had no as-of field at all.

A third capture, aimed deliberately at the pages nobody had visited, found it
in one run.

**The lesson worth keeping is about the shape of the search, not about DUO.** An
absence found by walking a capture is only ever an absence from that capture.
Proving a field does not exist requires visiting the pages that would show it —
and if that is not done, the honest word is "not found", not "does not exist".

The same capture also settled two other things the section below does not know:
`SaldoStartAflosfase` states what was owed when repayment began, so a starting
balance never needs estimating from a ledger; and
`bepalen-grondslaggegevens-over-periode` states the months of repayment left.

What remains true: the **transaction ledger** and the **monthly payment amount**
were not found outside `klantbeeld`.

---

## The as-of date — the original reasoning, now known to be wrong

The second capture kept the portal's own scripts, which are reachable once
signed in. They answer it outright.

`mijn-schulden-saldo-viewmodel.js`:

```js
this.saldoStudieSchuldBijgewerktTot = triggerableComputed(function () {
  return i.schuldsaldoBerekendTot
    ? formatNaarDagMaandJaarVolledig(i.schuldsaldoBerekendTot)
    : "onbekend";
});
```

and `mijn-schulden-aflossen-mapper.js`, where that value is built:

```js
schuldsaldoBerekendTot = chain(vorderingen)
  .filter(v => 0 < parseFloat(v.hoofdsom) + parseFloat(v.rente))
  .sortBy(momentToMilli("renteBerekendTot", "YYYY-MM-DD"))
  .head().get("renteBerekendTot").value()
```

So the date is the **earliest** `renteBerekendTot` among debts with a positive
balance, and `vorderingen` comes from **`klantbeeld` and nowhere else**. Every
data endpoint in both captures was checked; not one of the narrow ones carries
the field.

**Therefore this connector cannot state an as-of date.** The only source is the
2.5 MB dossier, and reading a BSN, both parents and twenty years of income to
timestamp a debt figure is not a trade this platform makes. The record carries
no as-of date and the manifest says why.

That is a real loss and should be named as one: a consumer showing a months-old
balance as current is exactly the quiet failure this record shape exists to
prevent. What makes it survivable is that **DUO's own portal has already decided
what to do when the date is missing — it renders the string `"onbekend"`** — so
a consumer that shows the balance as undated is showing the user something DUO
itself is prepared to show them. Inventing "today" would not be.

---

## What was built

Mostly as planned. Where it differs, the capture is why.

- `ProviderKind.Registry`, `ProviderRuntime.BrowserInteractive` (T3).
- `AuthFlow.RemoteBrowser` with **zero declared fields** — the validator refuses
  a provider that declares any, which is what makes "no DigiD credential ever
  enters this platform" something the manifest *cannot* express rather than a
  promise in a document. CONFIRMED as necessary: the username and password go
  into `login.digid.nl`'s own form, and only the person signing in should type
  them.
- `AgentClass.Byo`, not `Pooled` — **what this run concluded, and NOT what the
  manifest says any more.** The reasoning was: Logius runs a registered
  misuse-detection algorithm over IP, failed authentications and BSN; a pooled
  fleet authenticating many distinct BSNs from one egress is that signature
  exactly, and the consequence lands on the citizen whose DigiD it was.

  **Changed to `Pooled` on 2026-09-21, by the account holder, deliberately.**
  Two things this run did not know. First, *nothing enforced the declaration*:
  the lease query matched on provider id and runtime alone, so every DUO run
  there has ever been — including the live sign-ins of 2026-08-11 this file is
  written from — was served by the operator's pooled fleet agent. It became a
  rule on 2026-09-20 and was one for a single day. Second, the clean-browser
  question and the Logius question are **different axes**: a pooled agent gets
  no profile directory and carries no session between runs, so nothing of one
  citizen's sign-in reaches the next — and none of that changes the *address*
  the authentication arrives from, which is what is scored. The risk above is
  real and it is about **one shared egress serving many households**, which no
  deployment here has: the fleet is a container on the account holder's own
  connection, serving one person, on the same address their own NAS has. The
  finding stands as the thing that brings the question back the day that stops
  being true, and the whole of it is written beside the field in
  `DuoManifest.Build()`.
- `UnattendedFetch = false` — CONFIRMED by `ForceAuthn=true` rather than
  expected. `LoginNeedsHeadedAgent = false`: the person DigiD needs has a phone.
- `SessionTtlSeconds = 900`, which is DUO's own figure:
  `sessietoken/rest/jwt` answers `{"timeout":900,…}`. The unit is not stated
  there and 15 minutes is the only reading that makes sense; being wrong costs
  little, because `ForceAuthn` means every sync needs a human regardless.
- `ChallengeType.QrDisplay` for the app path carries the PNG **read from the
  `src` attribute**, not a screenshot, plus the deep link from `data-code`.

**DROPPED: the `Config` value choosing `sms` or `app`.** The plan was a stored
preference defaulting to `sms`. It is wrong, and the reason is the flow itself:
a streamed login means **DigiD** asks that question, on its own screen, and the
human answers it. A stored preference could only ever contradict what they just
clicked. The adapter watches for a QR on every pass instead and relays one if it
appears, which is correct whichever button was pressed — and needs no setting a
user could get wrong.

**A guard that turned out to rest on an accident.** "Signed in" means a
`mijn.duo.nl/particulier/portaal` URL that is not in the login chain. DUO's SAML
entry point is on `mijn.duo.nl` and carries the dashboard's address inside it as
`Target=`, so the first URL of the login chain very nearly reads as success — it
escapes only because DUO writes `mijn.duo.nl:443` and the marker has no port.
Drop the `:443`, which is how most SAML deployments write a default port, and a
login would be sealed before DigiD was ever reached. Found by bite-checking: the
`/isam/` exclusion was an equivalent mutant against every captured URL, and is
now pinned by a test row that says plainly it is constructed rather than
observed.

`StudentDebt` is a new record rather than a `CreditRegistration`: that record's
`Amount` means what was borrowed rather than what is left, it has no as-of
field, and its status vocabulary has no value for *TERUGBETAALPERIODE*. It
carries **no as-of date**, because nothing narrow states one, and it carries
`TotalIsDerived = true` always — DUO publishes the components and states no
total anywhere, so the figure is our sum and a consumer is told so.

---

## The captures are gone

Pruned during analysis, then deleted outright once the fixtures existed. Removed
on sight during the run:

- `klantbeeld` (2.5 MB) — the dossier above.
- `mijn-berichten` ×3 (34 KB each) — the account holder's message history.
- `klanttiles` ×2, `profielklantmenu` ×3 — name, `persoonsId`, date of birth.

Three files were deleted that should NOT have been: `klantbeeld-service.js`,
`klantbeeld-util.js` and `lodash-klantbeeld-util.js`. Those are DUO's source
code, holding no data at all; a filter matching the word *klantbeeld* against
file NAMES took them along with the payload. The as-of date was settled from the
saldo and aflossen mappers instead, so nothing was lost.

**That filter is fixed, and fixed at the right end.** The recorder now refuses
these endpoints when the body arrives, keyed on the response URL's PATH, so the
dossier is never written to disk rather than written and then deleted. It cannot
take a script with it, because a payload and DUO's own javascript are told apart
before the rule is consulted at all. The trail still records that the call
happened and why its body is absent — an endpoint missing entirely would read as
one the portal never called, which is the opposite of what the klantbeeld
finding needed to say.

What the captures left behind is in
`registry-connector/src/RegistryConnector.Adapters/Fixtures/duo`: the debt
payloads with the amounts changed, and the QR block with its session handle and
its PNG replaced. The notation is untouched — `0E-8` and all — because the
notation is the shape and only the numbers were ever the account holder's.
