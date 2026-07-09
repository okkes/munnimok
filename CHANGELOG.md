# Changelog

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
