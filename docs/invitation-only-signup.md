# Invitation-only sign-up

*2026-10-07 (user request): "I don't want just anyone to be able to register. Once invited, they should be able to sign up with e-mail, Google, Apple, and so on. Configurable from the wizard, automated by the flag."*

## What Logto offers (1.43)

- `signInMode: 'SignIn'` on the sign-in experience closes registration: the Create-account link goes, `/register` redirects to sign-in, and a Google or Apple identity Logto has never seen gets "The social account has not been registered yet." Existing accounts keep every method.
- A **one-time token** (`POST /api/one-time-tokens { email, expiresIn }`) is Logto's invitation: the person opens the app with `one_time_token` + `login_hint`, Logto verifies the token and **registers the e-mail even with registration closed** ("targeted user invitation"), or signs the existing account in.
- `prompt=select_account` is not supported (logto-io/logto#6921); organization invitations need an organization and still rest on the token; Logto sends no free-form e-mail through its connectors.
- With `socialSignIn.automaticAccountLinking: true`, a later Google or Apple sign-in whose verified e-mail matches the account links and signs in without a prompt.

## Decision

- **Flag:** `features.inviteOnly` per environment (wizard: Settings → Sign-in → "invitation-only sign-up"; default off, a new environment starts open). The pending strip says Bootstrap + Deploy, because Logto is applied in Bootstrap.
- **Bootstrap (`infra/modules/logto.mjs`):** `applySignUpPolicy` PATCHes the tenant to `signInMode: 'SignIn'` with automatic account linking when the flag is on, and back to `SignInAndRegister` when it is off; `ensureManagementAccess` gives the `<stack> api m2m` app the "Logto Management API access" role (the API mints the tokens with it; account deletion needed it too). The tenant's sign-up identifiers stay as they are: the tenants have no e-mail connector yet, and an e-mail identifier or an e-mail verification-code method is refused without one. A connector is a later step that would also unlock e-mail-code sign-in and password reset by mail.
- **API:** `GET/POST/DELETE /admin/invitations` on the admin scope mint, list and revoke one-time tokens (two days) and return the magic link `https://<web>/invite?token=…&email=…`. `/health` reports `capabilities.inviteOnly`.
- **Admin portal:** an Invitations page — type an e-mail, copy the link, see the active ones, revoke. **Nobody mails the link:** the operator hands it over (WhatsApp, e-mail); there is no mailer in the platform.
- **App:** `/invite` is a universal link and a public route; the page shows "Continue as <e-mail>" and sends `signIn({ extraParams: { one_time_token, login_hint } })` **on a tap only** (a mail gateway running JavaScript would burn the single-use token). Logto then asks the invitee for a username and a password on its own "complete profile" screens (the tenant is a username tenant), and from there on every configured method works: Google and Apple link on the matching e-mail, e-mail + password works at once. The login screen says "Sign-up is by invitation here" when the capability is on.

## Caveats

- Apple's "Hide My Email" relay address and a Google account on another address do not auto-link; the invitee signs in with the username + password Logto asked for, then links the social identity in the account center.
- Turning the flag off reopens registration but leaves the Management role in place.
- On iOS the magic link must be tapped (a universal link from a tap, not a redirect).
