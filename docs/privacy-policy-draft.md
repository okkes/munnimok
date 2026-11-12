# munni privacy policy — draft

> **Draft for the owner to review (#567).** Not published anywhere and not linked from the app.
> Items marked **[CHECK]** are statements I could not verify from the code or that only the owner can decide;
> items marked **[FILL IN]** need a fact from the owner. Once the text is approved it gets a Dutch and a Turkish
> version and the login screen's "Terms & Privacy Policy" becomes a link to it.

_Last changed: [FILL IN date]_

## Who is responsible

munni is run by **[FILL IN: name of the person or company]**, **[FILL IN: address or country]**.
Questions and requests about your data: **[FILL IN: e-mail address]**.

## The short version

- Your money data is yours. munni does not sell it, does not show ads and does not build advertising profiles.
- munni works on your device first. With an account, your data is also kept on munni's own server so your devices
  and the people you share a space with see the same thing.
- Without an account (an offline profile) nothing leaves your device — no sync, no crash reports.
- A few features need an outside service. Each one is listed below with exactly what it receives, and the ones
  that send something personal ask you first.

## What munni keeps

| What | Where it comes from | Where it is kept |
|---|---|---|
| Your account: e-mail address, name, picture | You, or Google / Apple when you sign in with them | munni's sign-in service and server |
| Accounts, transactions, balances | You type or import them, or a bank connection you set up delivers them | Your device; munni's server when you have an account |
| What you add to them: categories, notes, budgets, plans, goals, events, debts, splits | You | Your device; munni's server when you have an account |
| Receipts: photos, lines, invoices | You photograph them, or a shop connection you set up delivers them | Your device; munni's server when you have an account |
| Connections to banks, shops and registries | You | A sealed session key that only your devices hold; munni's server never sees a password |
| App lock PIN, device settings, the choice whether receipt photos may be read by AI | You | Only on that device |
| Activity history of a space | The actions of its members | Your device; munni's server |

## Who else sees your data

**People you choose.** Members of a space see that space's accounts, transactions, receipts and plans. Friends see
your name and picture. Members of a split event see the transactions added to that event — never the space or
account they came from.

**Services munni uses.** Nothing below receives more than what is listed.

| Service | When | What it receives |
|---|---|---|
| Google or Apple sign-in | Only when you choose to sign in with them | That you are signing in to munni; they tell munni your e-mail address and name |
| Your bank, through a licensed account-information provider **[CHECK: name the providers per environment — Enable Banking, GoCardless]** | Only for a bank you connect | Your consent, given at your bank. Access is read-only: munni can never move money |
| A shop or registry you connect | Only for a party you connect | Your sign-in at that party, made by you |
| Claude, by Anthropic (United States) | Only after you say yes to "Read receipts with AI", per device; you can switch it off again | The receipt photo and the names of your categories. munni's server passes the photo on and keeps nothing of it. **[CHECK: Anthropic's retention and training terms for the API account in use]** |
| Brave Search | Only when you search the web for a picture | The words you search for. The picture you pick is fetched by munni's server, not by your device |
| logo.dev **[CHECK]** | When munni looks up a brand logo | The brand's name or website |
| Apple / Google push services | Only if you allow notifications | The notification's text **[CHECK: what the payload contains]** |
| munni's own error service (run by munni, not an outside company) | When the app crashes and you have an account | Technical details of the error. **[CHECK: confirm no amounts, names or descriptions are included]** |

munni does not use analytics or advertising services.

## How long

Your data is kept until you delete it or delete your account. Deleting your account removes your data from munni's
server **[CHECK: within how many days; what happens to spaces you share and to split events you are part of]**.
Backups **[FILL IN: whether there are backups and how long they are kept]**.
A receipt photo sent to be read is not stored by munni's server.

## Where

munni's server is in **[FILL IN: country]**. Receipt photos read by Claude are processed in the United States
**[CHECK: the legal basis for that transfer — the provider's standard contractual clauses]**.

## Your rights

You can see, correct, export and delete your data, and withdraw a consent you gave (for example: switch off
reading receipts with AI, disconnect a bank, turn off notifications). Most of this is in the app itself; for
anything else write to the address above. If you live in the EU you can also complain to your data-protection
authority — in the Netherlands the Autoriteit Persoonsgegevens.

## Changes

When this policy changes in a way that matters — a new outside service, a new kind of data — munni tells you in
the app before the change takes effect.
