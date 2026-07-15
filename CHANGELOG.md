# Changelog

## [1.11.0](https://github.com/okkes/munnimok/compare/v1.10.0...v1.11.0) (2026-07-15)


### ✨ Features

* **native+ui:** staging Android unblocked; themed status bar; dev icon; split-aware rows; richer forecasts; review bulk sheet ([1596838](https://github.com/okkes/munnimok/commit/1596838d65f68ec6a4be319271d8c31992791b99))

## [1.10.0](https://github.com/okkes/munnimok/compare/v1.9.0...v1.10.0) (2026-07-15)


### ✨ Features

* **ui:** brand logos fill their tiles; auth callback failures show the error ([d8d539f](https://github.com/okkes/munnimok/commit/d8d539fb2e73b02bba0a20ca589e670b085d228f))

## [1.9.0](https://github.com/okkes/munnimok/compare/v1.8.1...v1.9.0) (2026-07-15)


### ✨ Features

* **ci:** NAS diag folder listing mode ([0664118](https://github.com/okkes/munnimok/commit/066411840bade316132c7ae02c04562e078ba988))
* **deploy:** NAS diagnostics without SSH (FileStation download + status dumps) ([f16109d](https://github.com/okkes/munnimok/commit/f16109d8390eec7a195455e4b458b9441f410c0a))


### 🐞 Bug Fixes

* **ci:** NAS diag paths derive from SYNOLOGY_PATH; detect HTML error pages ([9258009](https://github.com/okkes/munnimok/commit/9258009e461af465e058a626d4fff8382691a786))
* **deploy:** create the import-watch mount dir before compose up ([b5718e3](https://github.com/okkes/munnimok/commit/b5718e359dc017c0790c6fdf603160848579b790))
* **deploy:** failed updates retry next cycle (marker records success only) ([c8ba642](https://github.com/okkes/munnimok/commit/c8ba6420250d7d567943445bb4a8fbfbb70419e3))
* **deploy:** glitchtip migrate via manage.py; status dump survives up failure ([e9b78bf](https://github.com/okkes/munnimok/commit/e9b78bf1a3cc58c81695323d2895c6d36dc270b3))

## [1.8.1](https://github.com/okkes/munnimok/compare/v1.8.0...v1.8.1) (2026-07-15)


### 🐞 Bug Fixes

* **deploy:** Synology upload _sid in query string; de-flake review expand assert ([97fd457](https://github.com/okkes/munnimok/commit/97fd45717bb660007a287fdab10372011ebe7081))
* **native:** revert test-patched google-services.json ([bdd107c](https://github.com/okkes/munnimok/commit/bdd107cde3cd7c5465ea7a57faacba80df6a3deb))

## [1.8.0](https://github.com/okkes/munnimok/compare/v1.7.0...v1.8.0) (2026-07-15)


### ✨ Features

* **native:** dedicated staging apps + templated NAS env + self-updating deploy scripts ([b63f792](https://github.com/okkes/munnimok/commit/b63f7927b5bf87f7c15f59da0160e1e5b59f8c66))


### 🐞 Bug Fixes

* **ci:** patch iOS bundle id in pbxproj, not via xcodebuild arg ([11a5734](https://github.com/okkes/munnimok/commit/11a573413657ae4c621c3aa6a0f8842d50b18734))
* **ci:** pin iOS archive to the cloud-managed Apple Distribution cert ([f0ada94](https://github.com/okkes/munnimok/commit/f0ada945324b719be894456ca988e97d436aa67b))
* **ci:** prune CI-minted Apple Development certs before iOS archive ([47a58a7](https://github.com/okkes/munnimok/commit/47a58a7a44e1732ab3aed47f8b8fc25453e39243))
* **deploy:** keep .env on the NAS only; staging channel; stop sourcing env file ([22f5130](https://github.com/okkes/munnimok/commit/22f513029fea038e13389b4c460cfeab77455bdb))

## [1.7.0](https://github.com/okkes/munnimok/compare/v1.6.0...v1.7.0) (2026-07-15)


### ✨ Features

* **demo:** rich date-relative profile for every feature ([8a1433e](https://github.com/okkes/munnimok/commit/8a1433e8d25526f5c06c55e958f8949a1d693629))
* **deploy:** GitHub → Synology auto-deploy over FileStation API (no SSH) ([3ed63ae](https://github.com/okkes/munnimok/commit/3ed63ae681bcb2ba25034adf65733822326d6639))


### 🐞 Bug Fixes

* **native:** login redirect, no SW toast, FCM health flag, iOS archive dest ([06b1015](https://github.com/okkes/munnimok/commit/06b1015c622b45ad8cd0580facf721ce6194f7a5))

## [1.6.0](https://github.com/okkes/munnimok/compare/v1.5.0...v1.6.0) (2026-07-15)


### ✨ Features

* **export:** CSV / JSON export of transactions (csv-export design) ([fb97377](https://github.com/okkes/munnimok/commit/fb97377c335bb817628a0bca8ad1baac634b35e6))
* **help:** 1.6.0 notes; trends gallery + guide section; retire shipped designs ([78d4636](https://github.com/okkes/munnimok/commit/78d4636385067c5159fa877f41e38e3f0ae3520f))
* **home:** cash-flow forecast — safe to spend until payday (F1+F2) ([5c4c3f5](https://github.com/okkes/munnimok/commit/5c4c3f5c0302a28a8a32515a9cb148cbc0f70374))
* **native:** R8 minification + Play mapping upload; TestFlight lane ([bbfeba5](https://github.com/okkes/munnimok/commit/bbfeba5ad3c42403a39294392e36308c3399add5))
* **recurring:** subscription intelligence — yearly truth, price changes, review hint ([cf18cd2](https://github.com/okkes/munnimok/commit/cf18cd23d278bf15ad1f3afb74b256f9431984eb))
* **trends:** category bars, cash flow and net worth over time (T1-T3) ([6ebfc2e](https://github.com/okkes/munnimok/commit/6ebfc2e5a8bd49879700a457817f4f8c6aafaa93))

## [1.5.0](https://github.com/okkes/munnimok/compare/v1.4.0...v1.5.0) (2026-07-14)


### ✨ Features

* **accounts:** show when each financial account last synced ([a82f0d7](https://github.com/okkes/munnimok/commit/a82f0d7a5ee8d86f88c46c716a7a15d5f079f8d7))
* **desktop:** redesign D1-D5 — density, focus review, home columns, keys ([28255af](https://github.com/okkes/munnimok/commit/28255af192f53849728fcc38cfd3782e52dd239f))
* **help:** extend 1.5.0 notes (desktop overhaul, leave space, sync times); refresh gallery + guide ([c3bb580](https://github.com/okkes/munnimok/commit/c3bb58084f5aa3329834bb52ef03632093e4e68b))
* **help:** reimbursements line in the 1.5.0 notes ([9f6ec11](https://github.com/okkes/munnimok/commit/9f6ec119d94a2ff56ac985fa48f360c577bca3d9))
* **native:** master-only app builds; no PWA install nudge in the shell ([c9730c6](https://github.com/okkes/munnimok/commit/c9730c6e634f883bd7fe9cc56c04637cc29c9566))
* **native:** signed release pipeline — keystore, versioned bundle, Play internal upload ([5b2176a](https://github.com/okkes/munnimok/commit/5b2176a333d49377fc1972f318a18bc24f3ff812))
* **spaces:** leave a shared space from space settings ([5023103](https://github.com/okkes/munnimok/commit/5023103eb7fd021eb31993084b84b3a3f1b07546))
* **tx:** reimbursements work from the income side; credits net out; settled self-files ([c30cffe](https://github.com/okkes/munnimok/commit/c30cffedc168db74218cbdecf3d25d49313522e2))


### 🐞 Bug Fixes

* **ci:** gradlew executable bit + chmod guard in the android workflow ([ed14792](https://github.com/okkes/munnimok/commit/ed1479209949f0a6b5e93211f22acabd8ced253d))
* **desktop:** center the review deck; level the Home column tops ([36a6755](https://github.com/okkes/munnimok/commit/36a6755c4bf26a5883c698c9e732a982c0a90cf2))
* **native:** capacitor config as JSON — the CLI's TS parser dies under TypeScript 7 ([fabb618](https://github.com/okkes/munnimok/commit/fabb618553099e01223416e03b88c714b8746877))

## [1.4.0](https://github.com/okkes/munnimok/compare/v1.3.1...v1.4.0) (2026-07-14)


### ✨ Features

* alcohol/tobacco split, reachable expected-reimbursement, category-create door ([79a0ee7](https://github.com/okkes/munnimok/commit/79a0ee74d163c3d50da11117ebccd4103a129981))
* counterparty account number surfaces and joins to own accounts ([433f883](https://github.com/okkes/munnimok/commit/433f883ecbd6fe9784b359a88e939ad92e6483b0))
* Jumbo receipts connection; AH shows which recipe answered ([6cc6dba](https://github.com/okkes/munnimok/commit/6cc6dba96aa042eaa2babe47824e444adeb9b75b))
* pluggable bank-data providers with an admin picker; Enable Banking integrated ([f3241f7](https://github.com/okkes/munnimok/commit/f3241f7ff925fc4edf32b275540e26c25f2e1cbe))
* reserved (pending) bank charges + budget-aware GoCardless cadence ([2f191fa](https://github.com/okkes/munnimok/commit/2f191fa5b0fce1ce30c534d69bced9de091100c9))
* **server:** /logos/health canary diagnoses the logo.dev configuration ([8add34d](https://github.com/okkes/munnimok/commit/8add34db82ea8aeca1db3f3871fd55911b07afa0))
* **server:** watch-folder importer for manual CAMT exports ([3ae0425](https://github.com/okkes/munnimok/commit/3ae0425b3c759ba5642aaa881fd286256c9a1ad8))
* **web:** calmer review interactions ([f042586](https://github.com/okkes/munnimok/commit/f0425866e1c2669b2a93168592768480f7afd2c5))
* **web:** drop redundant members/accounts doors from space settings ([174437c](https://github.com/okkes/munnimok/commit/174437cbed1b2bebbf763759e32e899422577be6))
* **web:** event category breakdown drills into subs and filters payments ([7b24bef](https://github.com/okkes/munnimok/commit/7b24bef09aa618546f99dbfecc5426c61113c827))
* **web:** global settings behind a single door; drop viewport diagnostics ([e24385f](https://github.com/okkes/munnimok/commit/e24385f89a1d04c8c9c441e465e6a7be5e434e95))
* **web:** illustrated user guide shipped with the app at /guide/ ([fc94c69](https://github.com/okkes/munnimok/commit/fc94c69f0e8a46f99c3e97bcf16bfbe1717c92d9))
* **web:** in-app release notes ('What's new') ([9e56d49](https://github.com/okkes/munnimok/commit/9e56d49d1a4c77cd056c98ce9721109334df8375))
* **web:** new Home default order; portfolio becomes its own tab ([39376cc](https://github.com/okkes/munnimok/commit/39376cc675ddf9ddd4aba488d9d932e71843efa8))
* **web:** one switch hides every tip ([66ba8b6](https://github.com/okkes/munnimok/commit/66ba8b67f556e51f3acc7679ed63efeb688b1be4))
* **web:** receipts v2 — shared store connections, a real receipts home, matching ladder ([c1d9bfa](https://github.com/okkes/munnimok/commit/c1d9bfa60451fab417f35a85f8977726514cd757))
* **web:** review works on a staged draft — one write on Confirm ([010a582](https://github.com/okkes/munnimok/commit/010a5822c199730e75630584e6de8afb196cafda))
* **web:** smarter cross-space category prediction ([e0ced8e](https://github.com/okkes/munnimok/commit/e0ced8e5175b4725840b4128673eb47b377b0a37))
* **web:** transaction search matches amounts by digit substring ([f922195](https://github.com/okkes/munnimok/commit/f9221953ff301535fd651b627ead88828db6aa78))


### 🐞 Bug Fixes

* bank-consent return works from a plain browser tab (PWA journeys) ([362bf9f](https://github.com/okkes/munnimok/commit/362bf9faf6d2c9384dbf46de29a8ebbfbd78d031))
* **server:** one-time 90-day feed backfill for pre-migration bank accounts ([b2fe3c0](https://github.com/okkes/munnimok/commit/b2fe3c00e36972f9d58ee4a5d43d09fad65511a6))
* **server:** PayPal-style accounts without an IBAN connect properly ([c07b63a](https://github.com/okkes/munnimok/commit/c07b63af6287ed31fa7803e6604ff9181238a4ce))
* **web:** attach-sheet checkboxes update live; history start applies at attach ([f6b109c](https://github.com/okkes/munnimok/commit/f6b109cc5a06ad9070ff28549431c18750226dfb))

## [1.3.1](https://github.com/okkes/munnimok/compare/v1.3.0...v1.3.1) (2026-07-10)


### 🐞 Bug Fixes

* bulk-confirm list scrolls inside its card ([b70d1fc](https://github.com/okkes/munnimok/commit/b70d1fc688b033f2919418670287306145dbae70))
* **web:** the bulk-confirm list scrolls inside its card ([e5bab18](https://github.com/okkes/munnimok/commit/e5bab18613d24daaf5388c5000d8ae2d49325618))

## [1.3.0](https://github.com/okkes/munnimok/compare/v1.2.0...v1.3.0) (2026-07-10)


### ✨ Features

* **web:** U4 master-detail panes — the list stays beside its detail at lg ([5f9a41f](https://github.com/okkes/munnimok/commit/5f9a41f837a9bcb13027a54c184263412de69d7b))

## [1.2.0](https://github.com/okkes/munnimok/compare/v1.1.0...v1.2.0) (2026-07-10)


### ✨ Features

* **api,deploy:** GoCardless idle-requisition cleanup + container docs ([8e04ae3](https://github.com/okkes/munnimok/commit/8e04ae39418921127d8eca0d4d40e6c4da074586))
* **api:** fetch bank data once nightly at 03:00 bank-local time ([fac3270](https://github.com/okkes/munnimok/commit/fac3270828f010ed972e6ba81d4b0a1bd492b8c0))
* **deploy:** pgadmin console; run glitchtip migrations before boot ([f3fee51](https://github.com/okkes/munnimok/commit/f3fee5149cb9b2c77ce2622fa8bce5492deb5c4a))
* **web,api:** allocation — zero-based budgeting per the approved design ([4c5c7c4](https://github.com/okkes/munnimok/commit/4c5c7c4685ac2f8b4b030b6fd6aa1502cb968b21))
* **web,api:** budgets — cadenced limits, carry-over, exclusivity, home block ([66cca3f](https://github.com/okkes/munnimok/commit/66cca3f3ab75e9f9302b202301656ce89c26e5ee))
* **web,api:** events, goals and debts — entities, sync whitelist, domain math ([f3133f8](https://github.com/okkes/munnimok/commit/f3133f8f993ebe546777e1e47d12617962b8138d))
* **web,api:** insights — detector engine, six findings, weekly digest ([f74194c](https://github.com/okkes/munnimok/commit/f74194c8131f12da3d98339c2f9ff971416e9b46))
* **web,api:** portfolio — holdings, lots, delayed quotes, DEGIRO import ([987acb6](https://github.com/okkes/munnimok/commit/987acb650d8accffec640ea8745e4ab6109f17a6))
* **web,api:** real bank logos on account rows; logo.dev key guard ([2aca0e5](https://github.com/okkes/munnimok/commit/2aca0e522cbf917e3135743b3c5afc1aa5874acd))
* **web,api:** receipts S1 — photo proof on transactions ([b180277](https://github.com/okkes/munnimok/commit/b18027773df5e34e425c12cc541509cb56f8201b))
* **web,api:** receipts S2 — Albert Heijn adapter, matcher, proxy, OCR ([3ce4f5a](https://github.com/okkes/munnimok/commit/3ce4f5a609011efebf82270426884707687bbae2))
* **web:** customizable landing zone; settings grouped by scope ([de39bfd](https://github.com/okkes/munnimok/commit/de39bfd120af5244a4b0e134e7e4deb33b41361b))
* **web:** events, goals and debts screens with home blocks and settings entry ([0c596d6](https://github.com/okkes/munnimok/commit/0c596d616ac7516b790264ca583b56aef0aedbab))
* **web:** highlight search matches; logo search leads with logo.dev ([1d67960](https://github.com/okkes/munnimok/commit/1d67960b967af28e7009d02107b566c78d735306))
* **web:** home intelligence — new-transactions block and feature doors ([2d31058](https://github.com/okkes/munnimok/commit/2d31058d6ca6193da1dbb61e9f7232626d540195))
* **web:** home refresh — review card, dated rows, notification bell ([77fcc10](https://github.com/okkes/munnimok/commit/77fcc10e0b952065bb7d70396a6edb124f846625))
* **web:** home space switcher, offline pill, notification deep-links ([5410989](https://github.com/okkes/munnimok/commit/54109892027bb1102bdbf7fbc1e3951da80ca018))
* **web:** in-context category drill replaces the transactions forward ([9752cfb](https://github.com/okkes/munnimok/commit/9752cfb95249b416a9181f259a9d231d81a92573))
* **web:** low-budget alerts fire with the app closed (budgets P4) ([47a1a30](https://github.com/okkes/munnimok/commit/47a1a30d0be51f731e95b65f4155cfc170b4a8e6))
* **web:** offline-aware login, friend-delete confirm, spaces screen polish ([8eab454](https://github.com/okkes/munnimok/commit/8eab454283ab1dcb6e834de3b18fcae50869221c))
* **web:** PWA install hint + platform install tour ([c6e8ee4](https://github.com/okkes/munnimok/commit/c6e8ee4980ab2008cbbe6e53a0aa4faca62763c6))
* **web:** receipts browser + loud AH connection state ([5a7abd6](https://github.com/okkes/munnimok/commit/5a7abd617fa787da7a4f977dd10cb43e7319cba8))
* **web:** recurring custom cadence - every N weeks/months/years ([11bf2eb](https://github.com/okkes/munnimok/commit/11bf2eb8a393a504032428bc3afbc97f2c611c4e))
* **web:** recurring detail screen + detection inbox ([85f6bfe](https://github.com/okkes/munnimok/commit/85f6bfe203928896fa95bd921c29d2113f3d02db))
* **web:** recurring polish, press feedback, chart motion ([21bcc21](https://github.com/okkes/munnimok/commit/21bcc21ddaa252769f13b4aa772641ef95d2c1e8))
* **web:** reimbursements tell both sides; drills show the slice ([528608c](https://github.com/okkes/munnimok/commit/528608cc30cbc11dcd7959cb92bb5d98c98f7264))
* **web:** remarks batch 1 — events with pictures, clearer review, tokens ([d1bfa5c](https://github.com/okkes/munnimok/commit/d1bfa5c9f1b7f34dfa56d4e415508bc54be36c1d))
* **web:** review redesign — account-first type, valid categories, % splits ([b2c1110](https://github.com/okkes/munnimok/commit/b2c111038b93d80b13f3ae09c4e79f74bc7fc7ee))
* **web:** space accounts and members get their own screens + settings rows ([d00b355](https://github.com/okkes/munnimok/commit/d00b355a2ab853cd0a4f26f71e89205205885231))
* **web:** staging PWA wears the white leaf on brand green ([52252c0](https://github.com/okkes/munnimok/commit/52252c0fb0bf6d1852a3658d9e8d63b1d6d7f594))
* **web:** tours for every feature ([64462e4](https://github.com/okkes/munnimok/commit/64462e46be895cad76995a7a6124137c84c688ac))
* **web:** tutorial content for events, goals, debts and allocation ([14bd7a5](https://github.com/okkes/munnimok/commit/14bd7a5a300c7dcb8acfafbe69c4f9fba0446f41))
* **web:** tutorials — intro cards, slide tours, spotlight walkthroughs ([cddc79d](https://github.com/okkes/munnimok/commit/cddc79d6fe79b7ac2b5bb670cd31de6e85baf9a8))
* **web:** U4 desktop slice + U5 polish ([2da5749](https://github.com/okkes/munnimok/commit/2da5749e1ef98076e78d0c2ba638ef7831362764))


### 🐞 Bug Fixes

* **api:** honor the gocardless daily rate budget ([2bf2ebc](https://github.com/okkes/munnimok/commit/2bf2ebc032c280bdc880c52d99fac1e302383d41))
* **deploy:** pgadmin refuses .local emails — default to admin@munni.dev ([7b1aa73](https://github.com/okkes/munnimok/commit/7b1aa735cd7968f80f76cf4f03aa604ab9a9203f))
* **web,api:** 'Betaalautomaat' is a card payment, not a cash withdrawal ([8d8071b](https://github.com/okkes/munnimok/commit/8d8071b14ba0d0f934bcca4deca0765a13334062))
* **web,api:** sonar findings across the three new arcs + coverage tests ([243b02c](https://github.com/okkes/munnimok/commit/243b02ca5e75c65a879982963f936a24227352e3))
* **web,api:** sonar findings in the S2 arc ([375c96c](https://github.com/okkes/munnimok/commit/375c96c94b9a38b3512a232454f9465df4201fb6))
* **web:** AH receipts speak GraphQL, legacy REST as fallback ([588c183](https://github.com/okkes/munnimok/commit/588c1839ae34a7a80bf5164e18315762891a0a93))
* **web:** device-feedback round — keyboard space, footer, wheel drag, sync row ([a60613f](https://github.com/okkes/munnimok/commit/a60613fe79872bb5521f5f62b5d04481394ec938))
* **web:** footer status-bar mode + the small-remarks round ([5e0920c](https://github.com/okkes/munnimok/commit/5e0920cc11f91ce1beea72023801f92777788bdf))
* **web:** ios/android input bugs — sheets, drag, color input, footer ([1316144](https://github.com/okkes/munnimok/commit/13161445c99be70e7c2b50ac9cf2b8488124a5b9))
* **web:** last negated condition in the holding form ([4e48e8f](https://github.com/okkes/munnimok/commit/4e48e8f3f516c09b74087238ccb49f345e03aef8))
* **web:** narrow the event date via a local before formatting ([fa8a026](https://github.com/okkes/munnimok/commit/fa8a0264e777dd22191a8c1fe52d5d11a57f0dd4))
* **web:** sonar findings — negated ternary, missing test assertion ([10b81a6](https://github.com/okkes/munnimok/commit/10b81a6083a58627d9f5248bd425b31724f35188))
* **web:** standalone root reclaims the status-bar band (footer gap) ([e7560cc](https://github.com/okkes/munnimok/commit/e7560ccc5efd4a73780e4aa6a000a49e3c7a752b))

## [1.1.0](https://github.com/okkes/munnimok/compare/v1.0.0...v1.1.0) (2026-07-09)


### ✨ Features

* **admin:** standalone operator console in its own container ([0d497de](https://github.com/okkes/munnimok/commit/0d497de7502972071dcc1c00a589f85777b737ba))
* **api:** FluentValidation on every request body ([ed04382](https://github.com/okkes/munnimok/commit/ed0438201f83033bc6eb7437189e3359427218a1))
* **api:** GoCardless ingest writes the feed shape ([a986083](https://github.com/okkes/munnimok/commit/a9860835d824ea275541071e589963245ec794c6))
* **api:** push notifications for friend requests and space invites ([45b8ea1](https://github.com/okkes/munnimok/commit/45b8ea1cc9c4eb914fdb47f7b3bb7c638af99b0f))
* **api:** rate limiting, param-shape validation, nginx security headers ([55811cb](https://github.com/okkes/munnimok/commit/55811cbc9676d28dafdc6c3ffcdd99aa3e6a628f))
* **api:** Scalar API reference at /scalar ([068699c](https://github.com/okkes/munnimok/commit/068699cade851aa6b59903cb75720268b1d666ff))
* **api:** shared-accounts P2 — feed registration, attachments, derived access ([5dd541a](https://github.com/okkes/munnimok/commit/5dd541a83153c2f3e747c3a5c10f27131388a018))
* automated versioning via release-please ([67253ea](https://github.com/okkes/munnimok/commit/67253ea950a4a8037b1d416ec1a48417c57b6589))
* custom profile photos and space images, synced everywhere ([fc70594](https://github.com/okkes/munnimok/commit/fc70594c839144b16dcad3fa43719a04a3ff2610))
* **deploy:** per-environment env files + channel in version footer ([69708dd](https://github.com/okkes/munnimok/commit/69708ddae96ee0b713e6847731dfebf46736d09e))
* profile screen — avatar, display name, user id + email ([771f593](https://github.com/okkes/munnimok/commit/771f59314f35ffa9d4f38761276940b4770ab174))
* shared-accounts P5 — full two-user feed lifecycle proven end to end ([1ac9754](https://github.com/okkes/munnimok/commit/1ac975407cc1d0143e1d0dd279ae6c65d18bce49))
* spaces v2 — roles, settings, ownership transfer, leave ([3e2f145](https://github.com/okkes/munnimok/commit/3e2f145e702a76146f1aa8d3c5a2581696cc26d2))
* **sync:** near-real-time sync + fail-closed bootstrap ([1d9881c](https://github.com/okkes/munnimok/commit/1d9881cd4fa3e28de2e3a037c5386ff4d7773456))
* web push notifications + biometric app lock ([d5178bc](https://github.com/okkes/munnimok/commit/d5178bc699398ab31e71476490189c69a1889746))
* **web,api:** brand logos for recurring costs — logo.dev search + vendored fallback ([9bc97dc](https://github.com/okkes/munnimok/commit/9bc97dc05eb5946971597575ea015aea46c76874))
* **web,api:** recurring costs — tab, detection, reconciliation, reminders ([69475c0](https://github.com/okkes/munnimok/commit/69475c0adf7b0e5a2c0507c7128ba3b042cae454))
* **web:** adopt user-scoped categories when a space becomes shared ([717654b](https://github.com/okkes/munnimok/commit/717654b89a5bebf59ce7bce0dc5cb03668b236d5))
* **web:** background sync — push-triggered pull + Android outbox flush ([2b53f19](https://github.com/okkes/munnimok/commit/2b53f199c46cb97a68ffff0ed128fc6c923cdf28))
* **web:** custom colors, move-to picker, drag-to-move subs, iOS viewport fix ([aa84424](https://github.com/okkes/munnimok/commit/aa8442496ff8d413a999f43b146a90ee6284d852))
* **web:** dated account balances — newest information wins ([c3b24f7](https://github.com/okkes/munnimok/commit/c3b24f77f10b8314ad70c6169a15525e651da855))
* **web:** design polish batch — login, lock screen, PWA icon, empty states ([6a9f2aa](https://github.com/okkes/munnimok/commit/6a9f2aa4296d617d42ed15e7d3fb0aeba6323778))
* **web:** EN/NL/TR strings for overview and onboarding bank step ([b8db7d8](https://github.com/okkes/munnimok/commit/b8db7d8672b820ce682d52f0f175aeb133bc4cc3))
* **web:** full category system — mains with types, sub directions, scopes ([2feffa3](https://github.com/okkes/munnimok/commit/2feffa378a39185bcc755e9bcb44f1223759491a))
* **web:** history-first category prediction ([0b56c77](https://github.com/okkes/munnimok/commit/0b56c773df8abe4153af9d0c738a1f81f757e791))
* **web:** home becomes a landing zone of compact blocks ([952cc35](https://github.com/okkes/munnimok/commit/952cc353ab9cf116986bae64abe54b18c4b9aca6))
* **web:** identity-scoped app lock, dvh frame, desktop login, inline add-friend ([3e1a773](https://github.com/okkes/munnimok/commit/3e1a77302ed9713ce3a01d6b8a1a87e5f23781d9))
* **web:** ING CSV imports — one statement pipeline for every format ([dfb4cdf](https://github.com/okkes/munnimok/commit/dfb4cdf1280f9c93ad0fd53cf259a9cf254bf738))
* **web:** onboarding offers the bank connection as step 2 ([729d599](https://github.com/okkes/munnimok/commit/729d599425277796267c7c9f54dc7bf24f1abf5e))
* **web:** period overview with category drill-down ([7d3c741](https://github.com/okkes/munnimok/commit/7d3c741ea49af0bf052ae8a62fcc94a004bdbea1))
* **web:** period start weekday, overview drill-down, lock + layout polish ([6daf7ab](https://github.com/okkes/munnimok/commit/6daf7ab1c878c5ffa4ac52aa68212a29b6728a0f))
* **web:** review rebuilt — reasons, bulk confirm, splits/type, recurring link, skip pile ([64f6307](https://github.com/okkes/munnimok/commit/64f63074d623bacb142a69bfe74e57b3008060dd))
* **web:** shared-accounts P1 — feed/overlay schema + join layer ([2cb4472](https://github.com/okkes/munnimok/commit/2cb44728e5f918e67367ae888f276ec5044abe6e))
* **web:** shared-accounts P3 — feed-native imports + R1 application layer ([f7b8ae1](https://github.com/okkes/munnimok/commit/f7b8ae134e2857968bccd22e35f5a80e7a8b61fe))
* **web:** shared-accounts P4 — global accounts overview + attach management ([1c019d9](https://github.com/okkes/munnimok/commit/1c019d9020cd79fd33e01e254887f00a6badd8a9))
* **web:** space settings become a dedicated screen ([1a9db89](https://github.com/okkes/munnimok/commit/1a9db89b63b9fd690e63a68bb9103794fc2e8e02))
* **web:** space settings rework + offline hardening ([555fa91](https://github.com/okkes/munnimok/commit/555fa91108c24a27680d601633dc016ffec1ee24))
* **web:** transactions filter sheet — accounts, types, categories, dates ([09a6226](https://github.com/okkes/munnimok/commit/09a6226a0ced07ebfa8f99d764deb8bbc0728db0))


### 🐞 Bug Fixes

* **deploy:** force LF line endings for files that run on Linux ([b890028](https://github.com/okkes/munnimok/commit/b8900289e43ebcf12306095b61f5b3cfbc71d85e))
* import STOCK_AVATARS in Settings.jsx (notifications crash on friend invite) ([c420ceb](https://github.com/okkes/munnimok/commit/c420cebe6c5c450d3d0cbbb345dfecda6fcd1663))
* show correct Transaction Review count for inactive shared profiles in switcher ([280f053](https://github.com/okkes/munnimok/commit/280f053856e29b1b71b7652843a18619f1e19453))
* **web,api:** sonar findings + races the coverage run exposed ([e16d2b8](https://github.com/okkes/munnimok/commit/e16d2b89c12da2d38b1c6de63784eac5c1b81900))
* **web:** cap footer safe-area inset; ci: Pages now hosts the legacy UI ([7ec8745](https://github.com/okkes/munnimok/commit/7ec8745a90fcf964097bf8eb60e8c086414262bc))
* **web:** import ASN bank CAMT.053 exports correctly ([d66e7e1](https://github.com/okkes/munnimok/commit/d66e7e1299309918cc5f5fcac66f6bd18fd2de1b))
* **web:** iOS standalone viewport re-measure + sonar cleanups ([3d055f4](https://github.com/okkes/munnimok/commit/3d055f4c044e2d093c3495fe0ad8a8088b391b30))
* **web:** name the failure when the server is unreachable at sign-in ([06d9415](https://github.com/okkes/munnimok/commit/06d9415db9ccb29bae84f137cd07bdc860e05f56))
* **web:** overview saving test starved its own waitFor — suite hung ([05821c5](https://github.com/okkes/munnimok/commit/05821c5c156ae85dc5689d475ae1eb50a0d9b7e7))
* **web:** security-extended findings — SW message origin check + SVG-only vendoring ([7700a17](https://github.com/okkes/munnimok/commit/7700a17fd7c3b63d9e8b9f7f035d788ed4986961))
* **web:** tab bar hidden behind Android system navigation ([7dab67d](https://github.com/okkes/munnimok/commit/7dab67d2c0f8ea1e0bf183f99dc13ce4b6d6663f))


### 🛠️ Build System

* **deploy:** local-only SonarQube analysis stack ([fec84b5](https://github.com/okkes/munnimok/commit/fec84b56c721648571e00acfab9c485bf0f48e42))
