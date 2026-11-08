# munni

A local-first personal-finance app: a TypeScript PWA (`apps/web`) with
native iOS/Android shells (`apps/native`), a .NET sync API (`server`),
and an operator console (`apps/admin`). Everything works offline; the
server only ferries encrypted-or-envelope data between your devices.

- **Architecture deep-dive**: [docs/architecture.md](docs/architecture.md)
- **Deploying**: [infra/README.md](infra/README.md) — platforms,
  environments and the setup wizard
- **Design decisions**: in the GitHub ticket that asked for each
  feature; `docs/` keeps the living documentation only.

## How "use my store logins on my other devices" works (in human terms)

When you connect a shop (Albert Heijn, Jumbo, …), the login tokens
normally live **only on that device** — munni's servers never see them.
That's safe, but it means connecting the shop again on every new
device.

If you turn on **"Use on my other devices"** (Receipts → Shopping
connections), munni syncs those logins for you — *without* giving the
server any way to read them:

1. Your first device invents a **secret key** that never leaves your
   devices. Your shop logins are locked with that key before they're
   uploaded — the server only ever stores the locked box, not the key.
2. A new device that signs in asks to join. It shows a **6-digit
   code**, and your existing device shows the code it sees for that
   request. If the two codes match, you tap **Approve** — that check is
   what makes it impossible for anyone (even the server) to sneak
   their own device into the middle.
3. Approving securely hands the secret key to the new device (locked
   specifically *to* that device — nothing else can open it). From
   then on the new device can unlock the shop logins and they just
   work.
4. You can **remove** a device at any time; it immediately loses
   access to future updates. Turning the feature **off** erases
   everything the server stored.

If you ever lose *all* your devices, the key is gone with them — you
just connect the shops once again. There is deliberately no backdoor
and no recovery copy on the server: a server that can't read your
logins also can't leak them.
