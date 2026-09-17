# Changelog

## [4.0.1](https://github.com/okkes/munnimok/compare/v4.0.0...v4.0.1) (2026-09-17)


### 🐞 Bug Fixes

* **ci:** pushes and image builds skip stacks whose GitHub environment does not exist; a deploy of an unbootstrapped environment ends with a notice ([24cfc96](https://github.com/okkes/munnimok/commit/24cfc964dabe1d2301614bc11939b76b6d540b5b))

## [4.0.0](https://github.com/okkes/munnimok/compare/v3.0.0...v4.0.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **api:** the Admin__Subs setting is no longer read and the admin_grants table no longer exists; operator access requires the `admin` scope on the API access token (a Logto API-resource scope granted through a role). GET/POST/DELETE /admin/admins and POST /admin/logto/lowercase-usernames are removed; /admin/users no longer reports isAdmin/bootstrap.
* **infra:** the iac twins, the legacy environments and every NAS_/IAC_ secret name are gone; stacks are munni-<platform>-<env|shared>, hosts munni-<env>-<platform>, GitHub environments <platform>-<env|shared>.
* **web:** an on-device database created by an earlier build is not upgraded — the product redeploys from scratch with no existing devices, users or databases, so no upgrade path is carried.

### ✨ Features

* **api:** admin access is the token's admin scope ([d132726](https://github.com/okkes/munnimok/commit/d132726a6eb8afc219878e7411972fa1587d7136))
* **api:** every link the server writes carries its gate and account type ([2ecc40e](https://github.com/okkes/munnimok/commit/2ecc40e92a01a65300532c83dd6589884f851d91))
* **api:** regenerate the schema as a single Initial migration ([79e4337](https://github.com/okkes/munnimok/commit/79e43371fc5475cc4af0203b97c92f88c182b56a))
* **infra:** platforms and environments as committed config — one shared stack plus N environments per platform (lcl, nas), generated names and ports, scope-aware secrets, per-environment Logto with the admin role, CI matrices from the config ([dad9ece](https://github.com/okkes/munnimok/commit/dad9ece6e6787d98d7d2555a28e206634dc8302e))
* **infra:** the cleanup check counts the trusted roots of earlier https families; the Leftovers card says how to remove them ([a45a6a2](https://github.com/okkes/munnimok/commit/a45a6a2decb3c5e2177c9585dc1382866e391024))
* **infra:** the helper drives platforms and environments — config as code, wizard store, lcl seeding on minted credentials, the Access endpoints, config commit; images build stack-agnostic ([541d3ab](https://github.com/okkes/munnimok/commit/541d3abc05e374e0f1e1fdf5ff7ba946a9e8e47f))
* **web:** follow the server contract — device header, typed links, named provider ([0154b6c](https://github.com/okkes/munnimok/commit/0154b6cfbc248b6a77b305b19330323f9e0ddf22))
* **wizard:** platforms, shared services and environment workspaces over the new helper ([e122f33](https://github.com/okkes/munnimok/commit/e122f33d375317800701b2ebc44569a7cf6a4be8))
* **wizard:** the Access endpoints use the injected fetch; runs carry their stack in the run name; the checklist describes the clean-slate platform model ([d5228d6](https://github.com/okkes/munnimok/commit/d5228d60e8c165458919cec294b14735ce3515b5))


### 🐞 Bug Fixes

* **infra:** the workflow matrices load nas stacks without the domain secret; bundle names are the stack name; a stack-scoped value never leaks from the shared store ([416bb64](https://github.com/okkes/munnimok/commit/416bb644576bed3bf5b4a9a26945a021df577229))
* **infra:** validate.mjs imported the removed localEnvRegistry — the local validators resolve the lcl platform's stacks ([24cd6aa](https://github.com/okkes/munnimok/commit/24cd6aaa24e28201718a7576c89fa3a59a9436e1))
* **web:** the boot chain keeps only the live passes after the two branches met ([4b67585](https://github.com/okkes/munnimok/commit/4b675854c80504217086aa3595b6a13871b49c40))
* **web:** the two positive tests assert; the progress bar exposes a native progress element ([fbb7c36](https://github.com/okkes/munnimok/commit/fbb7c36871b1e713ad3e4877edd20c992b291f6b))


### ♻️ Refactoring

* **web:** one Dexie schema version, no store-to-store migrations ([03fb50e](https://github.com/okkes/munnimok/commit/03fb50e1364151440019e62a77a8c2c11ef0bc8f))

## [3.0.0](https://github.com/okkes/munnimok/compare/v2.27.0...v3.0.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **tx:** accounts stamp their rows, transfers mint the counter leg (arc B)

### ✨ Features

* **accounts:** a space may call an account by its own name (refs [#239](https://github.com/okkes/munnimok/issues/239)) ([9f711e2](https://github.com/okkes/munnimok/commit/9f711e28c8a4015227ca714b0019bb5b084277cb))
* **accounts:** account type is a SPACE decision; funding accounts arrive (refs [#152](https://github.com/okkes/munnimok/issues/152), [#133](https://github.com/okkes/munnimok/issues/133)) ([8658eb0](https://github.com/okkes/munnimok/commit/8658eb091f408d5f0fe0ce1543c6f134a615cff9))
* **accounts:** collapsible space cards, quick attach, pruned done screen, faced filters, loan prefill (refs [#314](https://github.com/okkes/munnimok/issues/314) [#317](https://github.com/okkes/munnimok/issues/317) [#318](https://github.com/okkes/munnimok/issues/318) [#319](https://github.com/okkes/munnimok/issues/319) [#320](https://github.com/okkes/munnimok/issues/320) [#326](https://github.com/okkes/munnimok/issues/326)) ([a402f3d](https://github.com/okkes/munnimok/commit/a402f3d6a439f2c5cc2795c7f1d93f02eb95bdfd))
* **accounts:** connecting the same account IS owning it — co-owners, the orphan janitor, visible fetch outcomes (refs [#240](https://github.com/okkes/munnimok/issues/240)) ([4bcefa7](https://github.com/okkes/munnimok/commit/4bcefa7bb71a1acf22a61fbaab1fc1ef85e0a1f4))
* **accounts:** default accounts are born with the space (refs [#221](https://github.com/okkes/munnimok/issues/221)) ([0eb06ca](https://github.com/okkes/munnimok/commit/0eb06ca18b2d2070cfd0be3c221dbab0e7f9d74b))
* **accounts:** imports and bank links stay separate accounts until an explicit merge (refs [#311](https://github.com/okkes/munnimok/issues/311)) ([b0a5a52](https://github.com/okkes/munnimok/commit/b0a5a5216e78466e83f6f7aaaf1c512c15d640d9))
* **accounts:** quieter overview, direct edits, staged deletes — accounts board batch (refs [#206](https://github.com/okkes/munnimok/issues/206) [#207](https://github.com/okkes/munnimok/issues/207) [#208](https://github.com/okkes/munnimok/issues/208) [#227](https://github.com/okkes/munnimok/issues/227) [#205](https://github.com/okkes/munnimok/issues/205) [#185](https://github.com/okkes/munnimok/issues/185) [#179](https://github.com/okkes/munnimok/issues/179)) ([a277768](https://github.com/okkes/munnimok/commit/a277768542c6e1278c9e0710d2151950129992fa))
* **accounts:** reconcile asks first, narrates its run, and uses the desktop width (refs [#311](https://github.com/okkes/munnimok/issues/311)) ([cffe158](https://github.com/okkes/munnimok/commit/cffe1584b6f41b06809534c87166402746221443))
* **accounts:** reconcile shows labeled pairs, folds matches, surfaces failures, carries the review verdict (refs [#311](https://github.com/okkes/munnimok/issues/311)) ([8079fa9](https://github.com/okkes/munnimok/commit/8079fa921d87dfe1d156188681729fc84329996b))
* **accounts:** shared-space warning moves to attach; the attach door lands on the final step; pessimistic ETA start (refs [#308](https://github.com/okkes/munnimok/issues/308) [#310](https://github.com/okkes/munnimok/issues/310) [#300](https://github.com/okkes/munnimok/issues/300)) ([af4e7d9](https://github.com/okkes/munnimok/commit/af4e7d931c4149306cf0b153acd6980b9f4a5725))
* **accounts:** the auto-attach offer dies; unattached wears a badge (refs [#248](https://github.com/okkes/munnimok/issues/248) [#182](https://github.com/okkes/munnimok/issues/182)) ([6e01179](https://github.com/okkes/munnimok/commit/6e011794435d40dbaaa8c9e08f5b68e8fe39f002))
* **accounts:** the TYPE is a space-level fact (refs [#212](https://github.com/okkes/munnimok/issues/212)) ([d92b217](https://github.com/okkes/munnimok/commit/d92b2179f28693fda85a01279f9e657d99adf065))
* **accounts:** the type shows everywhere and changes behind a hard confirm (refs [#212](https://github.com/okkes/munnimok/issues/212)) ([e776778](https://github.com/okkes/munnimok/commit/e776778cd92e77c4d0121b6cca038982acc06b24))
* **admin:** split the operator consoles into two apps (refs LS5 LS6) ([dd4dc06](https://github.com/okkes/munnimok/commit/dd4dc06ad3fe477ba02c0cdada3a4d756b69bee2))
* **app:** accounts, spaces & import land their rounds (refs [#227](https://github.com/okkes/munnimok/issues/227) [#269](https://github.com/okkes/munnimok/issues/269) [#277](https://github.com/okkes/munnimok/issues/277) [#278](https://github.com/okkes/munnimok/issues/278) [#279](https://github.com/okkes/munnimok/issues/279) [#284](https://github.com/okkes/munnimok/issues/284) [#226](https://github.com/okkes/munnimok/issues/226) [#281](https://github.com/okkes/munnimok/issues/281)) ([ce96d93](https://github.com/okkes/munnimok/commit/ce96d93d9a5d6c96dcad9346d38081436c42a126))
* **app:** batch-10 wave 1 — feedback rounds land (refs [#262](https://github.com/okkes/munnimok/issues/262) [#231](https://github.com/okkes/munnimok/issues/231) [#255](https://github.com/okkes/munnimok/issues/255) [#151](https://github.com/okkes/munnimok/issues/151) [#194](https://github.com/okkes/munnimok/issues/194) [#267](https://github.com/okkes/munnimok/issues/267) [#273](https://github.com/okkes/munnimok/issues/273)) ([f93b22e](https://github.com/okkes/munnimok/commit/f93b22e04629ceec87db09ab06cb88273165d6b5))
* **app:** batch-10 wave 2 — the transaction, review & session set (refs [#148](https://github.com/okkes/munnimok/issues/148) [#243](https://github.com/okkes/munnimok/issues/243) [#268](https://github.com/okkes/munnimok/issues/268) [#233](https://github.com/okkes/munnimok/issues/233) [#270](https://github.com/okkes/munnimok/issues/270) [#195](https://github.com/okkes/munnimok/issues/195) [#265](https://github.com/okkes/munnimok/issues/265) [#266](https://github.com/okkes/munnimok/issues/266) [#267](https://github.com/okkes/munnimok/issues/267) [#201](https://github.com/okkes/munnimok/issues/201) [#260](https://github.com/okkes/munnimok/issues/260) [#263](https://github.com/okkes/munnimok/issues/263) [#269](https://github.com/okkes/munnimok/issues/269) [#272](https://github.com/okkes/munnimok/issues/272) [#275](https://github.com/okkes/munnimok/issues/275) [#282](https://github.com/okkes/munnimok/issues/282) [#136](https://github.com/okkes/munnimok/issues/136) [#146](https://github.com/okkes/munnimok/issues/146) [#262](https://github.com/okkes/munnimok/issues/262)) ([bda3c2a](https://github.com/okkes/munnimok/commit/bda3c2a5c0dcf9ef6228fb17ccf97a9df4ae9a15))
* **app:** batch-11 — twelve feedback rounds and nine fresh items land (refs [#136](https://github.com/okkes/munnimok/issues/136) [#168](https://github.com/okkes/munnimok/issues/168) [#198](https://github.com/okkes/munnimok/issues/198) [#227](https://github.com/okkes/munnimok/issues/227) [#233](https://github.com/okkes/munnimok/issues/233) [#255](https://github.com/okkes/munnimok/issues/255) [#267](https://github.com/okkes/munnimok/issues/267) [#270](https://github.com/okkes/munnimok/issues/270) [#273](https://github.com/okkes/munnimok/issues/273) [#277](https://github.com/okkes/munnimok/issues/277) [#285](https://github.com/okkes/munnimok/issues/285) [#286](https://github.com/okkes/munnimok/issues/286) [#288](https://github.com/okkes/munnimok/issues/288) [#289](https://github.com/okkes/munnimok/issues/289) [#290](https://github.com/okkes/munnimok/issues/290) [#291](https://github.com/okkes/munnimok/issues/291) [#292](https://github.com/okkes/munnimok/issues/292) [#293](https://github.com/okkes/munnimok/issues/293) [#295](https://github.com/okkes/munnimok/issues/295) [#160](https://github.com/okkes/munnimok/issues/160) [#148](https://github.com/okkes/munnimok/issues/148)) ([46bc4d3](https://github.com/okkes/munnimok/commit/46bc4d37df9aad552c9711336523fff817dff626))
* **app:** batch-12 — the peek popup, both-ways counter travel, and the round-5 polish set (refs [#168](https://github.com/okkes/munnimok/issues/168) [#198](https://github.com/okkes/munnimok/issues/198) [#233](https://github.com/okkes/munnimok/issues/233) [#255](https://github.com/okkes/munnimok/issues/255) [#273](https://github.com/okkes/munnimok/issues/273) [#290](https://github.com/okkes/munnimok/issues/290)) ([d585c24](https://github.com/okkes/munnimok/commit/d585c243dcafab9a365db973482ad91894bfb470))
* **app:** batch-13 — twelve rounds land (refs [#168](https://github.com/okkes/munnimok/issues/168) [#198](https://github.com/okkes/munnimok/issues/198) [#286](https://github.com/okkes/munnimok/issues/286) [#291](https://github.com/okkes/munnimok/issues/291) [#298](https://github.com/okkes/munnimok/issues/298) [#299](https://github.com/okkes/munnimok/issues/299) [#300](https://github.com/okkes/munnimok/issues/300) [#301](https://github.com/okkes/munnimok/issues/301) [#302](https://github.com/okkes/munnimok/issues/302) [#303](https://github.com/okkes/munnimok/issues/303) [#304](https://github.com/okkes/munnimok/issues/304) [#305](https://github.com/okkes/munnimok/issues/305)) ([c9c2bf9](https://github.com/okkes/munnimok/commit/c9c2bf94734885c78c1a0c3fbfd18a6e05e70b2a))
* **app:** cash wallet, recurring counterparty create + faces, steady logo sheet ([#348](https://github.com/okkes/munnimok/issues/348) [#341](https://github.com/okkes/munnimok/issues/341) [#343](https://github.com/okkes/munnimok/issues/343) [#344](https://github.com/okkes/munnimok/issues/344)) ([f8f0c44](https://github.com/okkes/munnimok/commit/f8f0c44c8ba94b6aa83968aead21577cc663151d))
* **app:** filter caption, upcoming see-all honesty + one sign, footer faces, shadow rings (refs [#320](https://github.com/okkes/munnimok/issues/320) [#334](https://github.com/okkes/munnimok/issues/334) [#286](https://github.com/okkes/munnimok/issues/286) [#327](https://github.com/okkes/munnimok/issues/327)) ([37ef820](https://github.com/okkes/munnimok/commit/37ef8201404b84ccdb282a6e9d5d45254fadf092))
* **app:** home quick-add FAB, kicked-out takeover, guarded drafts (refs [#180](https://github.com/okkes/munnimok/issues/180) [#173](https://github.com/okkes/munnimok/issues/173) [#179](https://github.com/okkes/munnimok/issues/179) [#164](https://github.com/okkes/munnimok/issues/164) [#195](https://github.com/okkes/munnimok/issues/195)) ([2f4acee](https://github.com/okkes/munnimok/commit/2f4acee56b751771e8e0eaf9ed765cb584a6799c))
* **app:** local builds carry a trust-certificate button on the login screen ([3c2c583](https://github.com/okkes/munnimok/commit/3c2c5832f910990039773e075aa5c9649a90a25a))
* **app:** polish + recurring rounds — one focus style, growing sheets, real dividers, the year chart, recurring counterparty (refs [#276](https://github.com/okkes/munnimok/issues/276) [#271](https://github.com/okkes/munnimok/issues/271) [#156](https://github.com/okkes/munnimok/issues/156) [#198](https://github.com/okkes/munnimok/issues/198) [#283](https://github.com/okkes/munnimok/issues/283) [#160](https://github.com/okkes/munnimok/issues/160) [#168](https://github.com/okkes/munnimok/issues/168) [#274](https://github.com/okkes/munnimok/issues/274) [#264](https://github.com/okkes/munnimok/issues/264)) ([8313023](https://github.com/okkes/munnimok/commit/8313023f86075b0c9c5a340ed9149bfa63972628))
* **app:** runtime-config overlay lets one public image serve every stack ([853a8e0](https://github.com/okkes/munnimok/commit/853a8e019203e13e769e237ec54eb2d4a5d03074))
* **app:** sparse desktop home centers wider; accounts overview becomes two honest segments (refs [#313](https://github.com/okkes/munnimok/issues/313) [#314](https://github.com/okkes/munnimok/issues/314) [#286](https://github.com/okkes/munnimok/issues/286)) ([a130e87](https://github.com/okkes/munnimok/commit/a130e8700caaa035ba9323b2d62cc3ce7273cc73))
* **banking:** the user picks the open-banking provider; EB rows say EB (refs [#175](https://github.com/okkes/munnimok/issues/175) [#176](https://github.com/okkes/munnimok/issues/176)) ([eea02c4](https://github.com/okkes/munnimok/commit/eea02c43233723900ae3ba68eff9b968d0554478))
* **camera:** take pictures everywhere — Android chooser, desktop webcam (refs [#166](https://github.com/okkes/munnimok/issues/166) [#160](https://github.com/okkes/munnimok/issues/160)) ([edefaef](https://github.com/okkes/munnimok/commit/edefaef8d12a531e45912af12f11ae606a1626ae))
* **cats,recurring:** parent-name search, locked Adjustment, typed form picker, year chart, occurrence review (refs [#214](https://github.com/okkes/munnimok/issues/214) [#187](https://github.com/okkes/munnimok/issues/187) [#261](https://github.com/okkes/munnimok/issues/261) [#256](https://github.com/okkes/munnimok/issues/256) [#167](https://github.com/okkes/munnimok/issues/167) [#168](https://github.com/okkes/munnimok/issues/168) [#257](https://github.com/okkes/munnimok/issues/257)) ([c8e91af](https://github.com/okkes/munnimok/commit/c8e91af43ca71cd6170ce27d3b87ce029d2a6c67))
* **cats:** direction and type leave the form — a category follows its parent's nature (refs [#244](https://github.com/okkes/munnimok/issues/244)) ([500b692](https://github.com/okkes/munnimok/commit/500b69244ce963b134b3acd055078f47ba5fd309))
* **cats:** special-family subs + the not-a-random-category mark (arc A) ([e7a1616](https://github.com/okkes/munnimok/commit/e7a16165ce6b21a437a9fc63a9b9f2711efd0bc5))
* **cats:** the Transfer family is a diamond pick — the ask answers it (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([07b1f2a](https://github.com/okkes/munnimok/commit/07b1f2a1aef61f0a1775585bda264f26b9889cb6))
* **debts:** loan detection lives on the debts screen (refs [#192](https://github.com/okkes/munnimok/issues/192)) ([88ea7bd](https://github.com/okkes/munnimok/commit/88ea7bd2e60a21376752b53448f057fc7650b207))
* **debts:** loan match sheet r3 - pinned footer math, deduct switches, bulk controls (refs [#286](https://github.com/okkes/munnimok/issues/286)) ([4e0bf8f](https://github.com/okkes/munnimok/commit/4e0bf8f414df75eb856b9aac7fc708ee026db5a8))
* **debts:** loan patterns detect like recurring — DUO leads the lender list (refs [#192](https://github.com/okkes/munnimok/issues/192)) ([c57742b](https://github.com/okkes/munnimok/commit/c57742b35cc460eede4ef4e9c23d3cdbe181b24c))
* **debts:** the payment plan gets its due day, and 'Current value' says what it means (refs [#190](https://github.com/okkes/munnimok/issues/190) [#191](https://github.com/okkes/munnimok/issues/191)) ([0809a61](https://github.com/okkes/munnimok/commit/0809a619df79fc8f6df47fd26fdf9422d6e0ea84))
* **deploy:** after a Deploy of the prod twin, wait for the poller, and once Logto answers with the seeded credential run the bootstrap once more ([a4cdcc8](https://github.com/okkes/munnimok/commit/a4cdcc8ffb5f58b12ba4bad856debd14c5b13f59))
* **deploy:** iac bundle channels reach the NAS poller (IAC4 complete) ([cb9bec9](https://github.com/okkes/munnimok/commit/cb9bec91924a2a4b0b3cf66e14880122995ee10b))
* **deploy:** the live pipeline ensures its own NAS poller through the DSM API on every deploy ([1904219](https://github.com/okkes/munnimok/commit/190421933d7a518e93a08a9e80d76917d7636b26))
* **diag:** memory-leak detection — heap watch + CI leak spec (refs [#135](https://github.com/okkes/munnimok/issues/135)) ([4f7415a](https://github.com/okkes/munnimok/commit/4f7415ad80af28947a58ed2e6f6a877d75282070))
* **events:** attaching transactions is a full screen (refs [#144](https://github.com/okkes/munnimok/issues/144)) ([e1f6032](https://github.com/okkes/munnimok/commit/e1f6032a5020a782b1ce30c0cf0cc11d66441cf9))
* **forms:** buttons stay tappable — an invalid tap names the blocker (refs [#195](https://github.com/okkes/munnimok/issues/195)) ([0c25089](https://github.com/okkes/munnimok/commit/0c250893ad715ced8f1b2b17a75847f2264dd15d))
* **gocardless:** connecting never attaches — the account is born global (refs [#204](https://github.com/okkes/munnimok/issues/204)) ([da8f4de](https://github.com/okkes/munnimok/commit/da8f4de62df846c4b167be894ffeba74291614cc))
* **home,tx:** sparse homes keep one column; one affordance rule; the checklist (refs [#155](https://github.com/okkes/munnimok/issues/155) [#229](https://github.com/okkes/munnimok/issues/229) [#194](https://github.com/okkes/munnimok/issues/194)) ([8319655](https://github.com/okkes/munnimok/commit/8319655472ae2c565517e5dba5d0538568fb003d))
* **home:** Explore is a first-class block (refs [#121](https://github.com/okkes/munnimok/issues/121)) ([e98737a](https://github.com/okkes/munnimok/commit/e98737a619f6633ee0f71fab966fd5e3a9743d44))
* **home:** the premade band modes are premade (refs [#142](https://github.com/okkes/munnimok/issues/142)) ([6bb6479](https://github.com/okkes/munnimok/commit/6bb64797d30165e170bc3b4b5f6fcfd20812993e))
* **home:** unused features gather in ONE Explore block (refs [#121](https://github.com/okkes/munnimok/issues/121)) ([2e45069](https://github.com/okkes/munnimok/commit/2e450693cde976221b92abd5354038ef1cfef592))
* **import:** importing never attaches by itself — joining a space is the user's move (refs [#204](https://github.com/okkes/munnimok/issues/204)) ([96dbde2](https://github.com/okkes/munnimok/commit/96dbde23439d2fd379cfc61537dd799846df9495))
* **import:** searchable bank chooser + live row-count progress (refs [#226](https://github.com/okkes/munnimok/issues/226) [#184](https://github.com/okkes/munnimok/issues/184)) ([540cc2a](https://github.com/okkes/munnimok/commit/540cc2a5541187bffdc19cbd522ec1b7623674ff))
* **infra:** a successful Save closes the Manage popup by itself ([68f3878](https://github.com/okkes/munnimok/commit/68f3878490be14b588b58bca3e2ce3417b9270cc))
* **infra:** Apple App ID as code — capabilities registered, legacy APNs dialog demystified ([9eeadb8](https://github.com/okkes/munnimok/commit/9eeadb8f85e78651993a378d1359dfb0943dff19))
* **infra:** bootstrap and verify print the poller's own log — what the NAS did with the bundles, without SSH ([f891fb5](https://github.com/okkes/munnimok/commit/f891fb5c41826adeea95f5364dacf58b188dbf87))
* **infra:** bootstrap claims Logto's console admin and the app's first user, and keeps every minted credential in the pair's vault ([0692c9d](https://github.com/okkes/munnimok/commit/0692c9dbaa48fcac9c006c90a847acf2479d2c13))
* **infra:** bootstrap ensures the wildcard certificate and the poller task on the NAS through the DSM API ([e0f5432](https://github.com/okkes/munnimok/commit/e0f543278b4ea6ce8a2cf79c876066f538813092))
* **infra:** both vantage points ask DSM the same question — is this session an administrator's? ([a5b4439](https://github.com/okkes/munnimok/commit/a5b4439a7bb5b5d5f5c7d6a7286ec9061f2551df))
* **infra:** burned store packages roll to a fresh generation — same environment, new identity ([bf77cb2](https://github.com/okkes/munnimok/commit/bf77cb287749277073eedda0edd957b6af905b0c))
* **infra:** cleanup as code — one confirmed click takes a twin (or the pair) off the NAS and GitHub ([0db5cb7](https://github.com/okkes/munnimok/commit/0db5cb799214ac947b61a7e21200bf172ed57195))
* **infra:** console shows LOGIN after auto-claim; the vault sets itself up ([42cb911](https://github.com/okkes/munnimok/commit/42cb911d620bf6fca12bf41e337c04541c5f9d5b))
* **infra:** credential checks in the wizard, mirroring real provider auth ([1c6d9c0](https://github.com/okkes/munnimok/commit/1c6d9c07e883ee3f7aa59db8e5ea495708821c5f))
* **infra:** delete verifies its own cleanup; stores can be retired; iOS names the missing app record ([e1ea0d2](https://github.com/okkes/munnimok/commit/e1ea0d22d41e114ce764f1cd627c29fa8a2909c7))
* **infra:** environments become dynamic; the vault gets real https; the wizard gets its visual pass ([6b3ae3b](https://github.com/okkes/munnimok/commit/6b3ae3b3e1681d8be5af029f0821ec0186a96f22))
* **infra:** every environment gets its OWN postgres; pgAdmin joins the shared stack ([da1f8c5](https://github.com/okkes/munnimok/commit/da1f8c5e351033fa1471fabe705b596261e5d83d))
* **infra:** every jump on the wizard scrolls, then pulses the exact spot ([87468ac](https://github.com/okkes/munnimok/commit/87468acc952acf077e0e75968609a7163c2db583))
* **infra:** features and their accounts are one grid of tiles, managed in place ([a721166](https://github.com/okkes/munnimok/commit/a721166c557f9b263179544267f9385490a1eba6))
* **infra:** Firebase push as code - no separate project, no separate credential ([bc6c775](https://github.com/okkes/munnimok/commit/bc6c775a20d2332af9f5c1d808867bae736260f4))
* **infra:** first-boot latch on every push workflow; delete clears the local env variables; publish credentials ride into the target repo ([36fa1ec](https://github.com/okkes/munnimok/commit/36fa1ecbed9bd600af0e68d4735cb8f7ed1a31a6))
* **infra:** GlitchTip as code on the NAS — admin and API token minted, created inside the container by the poller, DSNs written back without a registration ([f6b7e55](https://github.com/okkes/munnimok/commit/f6b7e5521723daae370694503c7638baa3ccd5ac))
* **infra:** guided setup wizard — infra/setup/index.html ([4ca3d0d](https://github.com/okkes/munnimok/commit/4ca3d0d1aee2c44526f82c8b56072c06a34012bc))
* **infra:** iOS names its own bundle id; the GitHub token persists; cloud-signing failures name their fix ([9f25f6e](https://github.com/okkes/munnimok/commit/9f25f6e84decb1e991631ae4046927c7844bd20b))
* **infra:** keystore self-mint for fresh repos; SERVICE_DISABLED 403s name the Cloud-side switch ([cc5e528](https://github.com/okkes/munnimok/commit/cc5e5287c51e1bd6cb92bcde8c6b65d36dc38238))
* **infra:** local family serves real https (sslip.io) + per-env store channels, vault folders, delete cascade ([7cda3c1](https://github.com/okkes/munnimok/commit/7cda3c1ee9fa2148af03ecd9f3746557fed69af0))
* **infra:** local helper — the wizard runs the local setup itself ([06aca60](https://github.com/okkes/munnimok/commit/06aca60af120d58da5de81a20fb11868c8327d88))
* **infra:** local three-stack family drives the wizard end to end (refs LS1 LS2 LS3 LS4) ([3a22394](https://github.com/okkes/munnimok/commit/3a223944ea778005435a98081a110e03d9896237))
* **infra:** local twin stack, GlitchTip-as-code, render-only mode ([06341e0](https://github.com/okkes/munnimok/commit/06341e0eb3db224a553ff691b88eae1c19cd6502))
* **infra:** Logto machine credentials are minted by bootstrap and seeded into Logto on the NAS — no console visit for the first credential ([daa0e88](https://github.com/okkes/munnimok/commit/daa0e883d9c87016fb5e3484be317583bdfc0218))
* **infra:** Manage is a popup, trust and registry are detected, Connect stores the token ([09fa259](https://github.com/okkes/munnimok/commit/09fa25992d584c0edf05d0f08e3db41ade53c8aa))
* **infra:** NAS readiness probed from outside, Bootstrap runs itself once DSM accepts the deploy account ([47cd94b](https://github.com/okkes/munnimok/commit/47cd94bfded95cc6262e7df6b76781d00c6fb9bc))
* **infra:** native apps ship from CI into the local family (LAN mode) ([337207e](https://github.com/okkes/munnimok/commit/337207e9cbd1cf3294c61a14eb14149239de08da))
* **infra:** one token — a wizard copy follows upstream's pipeline, the registry tile appears only for private images ([18ccf46](https://github.com/okkes/munnimok/commit/18ccf4623f43b41dfc57eea118e2e7bc62f3222f))
* **infra:** own Play publisher replaces the deprecated action; store probes never race an upload ([6c6f728](https://github.com/okkes/munnimok/commit/6c6f728531880981c762a77d9a58fe510dc69793))
* **infra:** paste the .p8 as-is — the wizard converts it ([9be2ea0](https://github.com/okkes/munnimok/commit/9be2ea0d4d2951cd910904cc4c0aace1ca29346b))
* **infra:** social sign-in setup goes as far as Google and Apple allow - deep links, callbacks, verified redirects ([6ea4d35](https://github.com/okkes/munnimok/commit/6ea4d35837a1e57b7c5836ab29b08c9607181473))
* **infra:** store-card Check buttons, store-truth publish decisions, secrets migration workflow ([cf7a725](https://github.com/okkes/munnimok/commit/cf7a725ad6e4e837cc416702f4b5621662b4421c))
* **infra:** store-readiness polling, full delete forgets prod, state-aware master card, template-copy repos, in-setup CA trust ([6e07a67](https://github.com/okkes/munnimok/commit/6e07a675e059b9e17b8b2bf4fbea2bf98244e0af))
* **infra:** the local app carries the family CA — no phone install for the app ([9969324](https://github.com/okkes/munnimok/commit/9969324b3e1fe4140c05aa86ac5b5a165b9ffb99))
* **infra:** the local track keeps itself current, owns its Apple signing certificate, gains Sign in with Apple ([fd35bcd](https://github.com/okkes/munnimok/commit/fd35bcd74a48856c40e22c86add0e0dd24e691c5))
* **infra:** the machine owns the upload keystore; master buttons lock as one row ([a717a6e](https://github.com/okkes/munnimok/commit/a717a6ee58a44ea618ac94cf38282c96b9b8f26d))
* **infra:** the operator names the store package; provider hiccups stop wearing config hints ([7eb4b54](https://github.com/okkes/munnimok/commit/7eb4b5480af6a45bd3f85deba89e437a36d48452))
* **infra:** the pair vault ships (SA1) + secret read-back; sign-in redirect fix ([6aebedf](https://github.com/okkes/munnimok/commit/6aebedf5856ac433c17dcb0c036933522db336e2))
* **infra:** the prod twin owns the NAS end to end — certificate bindings, live dir, chained staging + deploy; review fixes ([b33e370](https://github.com/okkes/munnimok/commit/b33e370edbd21c035b6dd5abfc2bbeccdebe52b1))
* **infra:** the readiness card shows how old GitHub's Synology secrets are — the run signs in with those, not with what is typed ([dfcbbbf](https://github.com/okkes/munnimok/commit/dfcbbbfc22a4854eab8a7b2f395bfe356d750642))
* **infra:** the session facts cover every init-data flag and every 2FA-related API DSM lists ([8d3871f](https://github.com/okkes/munnimok/commit/8d3871fb61ad261a808878ef92a8c9282966f776))
* **infra:** the setup wizard becomes one guided page ([527e9ca](https://github.com/okkes/munnimok/commit/527e9ca598e224c7fbecc2a4648bfb3f88c1179c))
* **infra:** the wizard picks features and manages integrations as tiles ([548b8f8](https://github.com/okkes/munnimok/commit/548b8f87f524a06a24a8d806021a75811b6b49a7))
* **infra:** the wizard splits into the family and its environments ([829160a](https://github.com/okkes/munnimok/commit/829160ac653a9b4037781f04a3e95b030ff93396))
* **infra:** verify prints how DSM shapes a reverse-proxy rule (field names only) — the binding matched one of seven ([00ae64b](https://github.com/okkes/munnimok/commit/00ae64bb1776d2979b80dbc7412a0575fc5ca468))
* **infra:** verify reads what DSM says about a refused session — 2FA enforcement, admin flag, API versions ([e06627d](https://github.com/okkes/munnimok/commit/e06627d0d8d969d36126c56872b9b4472b3a2f88))
* **infra:** wizard step 6 is a status card of the automated sign-in setup, a Vault tile joins the accounts; runbook, README and checklist follow ([24aee48](https://github.com/okkes/munnimok/commit/24aee48f40f6c1d9f73a544e8b7eb22fc245054b))
* **lists:** every list remembers where you were (refs [#131](https://github.com/okkes/munnimok/issues/131)) ([304b3b2](https://github.com/okkes/munnimok/commit/304b3b23dd38409320882d323de55542a4faebd2))
* **lock:** a refresh honors the configured auto-lock delay (refs [#315](https://github.com/okkes/munnimok/issues/315)) ([4fe576c](https://github.com/okkes/munnimok/commit/4fe576c7c0239b020d7c83c1dc5287ed7373ffd1))
* **native:** the LAN build is a real store channel (app.munni.local) ([ace731c](https://github.com/okkes/munnimok/commit/ace731caa9cf3510b65836dc7e1e14ce9835f5e3))
* **overview:** a tapped transaction stays in the overview ([#351](https://github.com/okkes/munnimok/issues/351)) ([7ebfd85](https://github.com/okkes/munnimok/commit/7ebfd85bcf1c00258472a9a35ddcfbc457b2fe5a))
* **push:** a new-transactions tap opens that space's review (refs [#132](https://github.com/okkes/munnimok/issues/132)) ([509283d](https://github.com/okkes/munnimok/commit/509283d00b65b1b7ec1860a48b2f6cdc80ee20a1))
* **pwa:** the munni leaf becomes the browser-tab favicon (refs [#230](https://github.com/okkes/munnimok/issues/230)) ([6c61547](https://github.com/okkes/munnimok/commit/6c6154733ac150cebcb029a578ef8cb29fb1da3d))
* **recurring:** a cost lives only in ranges it occurs in — five tabs, start-date floor (refs [#188](https://github.com/okkes/munnimok/issues/188) [#189](https://github.com/okkes/munnimok/issues/189)) ([e259245](https://github.com/okkes/munnimok/commit/e25924563b6f092ff6bbd050956bd089c41b1bbd))
* **recurring:** fixed costs shed the luxury flag; see-all lands on the combined Upcoming page (refs [#332](https://github.com/okkes/munnimok/issues/332) [#334](https://github.com/okkes/munnimok/issues/334)) ([c7cce01](https://github.com/okkes/munnimok/commit/c7cce01f0feafae11c50f7f269b11b37e5eb6afb))
* **recurring:** per-account detection, amount-tier patterns, echo dedup, named source ([#345](https://github.com/okkes/munnimok/issues/345) [#346](https://github.com/okkes/munnimok/issues/346)) ([4682afe](https://github.com/okkes/munnimok/commit/4682afe14a825d29e218ca622db32ee54eba463e))
* **review:** card redesign - wrapping titles, gated rows, split first, pick-by-counter ([#339](https://github.com/okkes/munnimok/issues/339)) ([f324f8c](https://github.com/okkes/munnimok/commit/f324f8ca732a92b49a444be2f6fa3267db54baf8))
* **review:** categories carry the whole decision — the kind row dies (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([5018776](https://github.com/okkes/munnimok/commit/5018776831c52338964ae458c9ae18011b7497ed))
* **review:** decisions carry weight — the memory learns habits, spreads and events, own space first (refs [#161](https://github.com/okkes/munnimok/issues/161)) ([ca94f2c](https://github.com/okkes/munnimok/commit/ca94f2ca78d70d02f182bb5f28c0a7f836865628))
* **review:** deck holds through the counter queue; movement confirms require their counterparty (refs [#268](https://github.com/okkes/munnimok/issues/268) [#309](https://github.com/okkes/munnimok/issues/309)) ([298b759](https://github.com/okkes/munnimok/commit/298b7593873d4d8baa9230fc03b0949619d6d46b))
* **review:** notes on the card, honest bulk line, the recurring face, late split reset, inset ring (refs [#316](https://github.com/okkes/munnimok/issues/316) [#324](https://github.com/okkes/munnimok/issues/324) [#325](https://github.com/okkes/munnimok/issues/325) [#330](https://github.com/okkes/munnimok/issues/330) [#331](https://github.com/okkes/munnimok/issues/331) [#333](https://github.com/okkes/munnimok/issues/333)) ([7fe027b](https://github.com/okkes/munnimok/commit/7fe027b6656923e0b2ed4cd365aebd71a68aa7d6))
* **review:** split parts carry the quick-create doors (refs [#251](https://github.com/okkes/munnimok/issues/251)) ([d2e7ca2](https://github.com/okkes/munnimok/commit/d2e7ca2883497df298dd9bfffe5bb268383e03d3))
* **review:** the counter transaction is a card fact — suggestions sheet, fork retired (refs [#237](https://github.com/okkes/munnimok/issues/237)) ([ea67d69](https://github.com/okkes/munnimok/commit/ea67d69f023097c67c00722fbc135f1165717053))
* **review:** the deck owns the stories — r3 refinements (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([71b6b3a](https://github.com/okkes/munnimok/commit/71b6b3aa90f8b66c12fe143ccf3f35aa2258c2ec))
* **review:** the split door moves last; desktop cards anchor to the top (refs [#249](https://github.com/okkes/munnimok/issues/249) [#151](https://github.com/okkes/munnimok/issues/151)) ([1e107f3](https://github.com/okkes/munnimok/commit/1e107f392387ea6340ea37ddbed16e87c14ab50f))
* **review:** the split stands in the open — stacked part cards (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([293f1a0](https://github.com/okkes/munnimok/commit/293f1a08afc7248d765794ac7473f67a34e3d138))
* **review:** the split warning reads the visible story; field-styled notes; bulk chevrons; honest counter copy (refs [#330](https://github.com/okkes/munnimok/issues/330) [#324](https://github.com/okkes/munnimok/issues/324) [#328](https://github.com/okkes/munnimok/issues/328) [#321](https://github.com/okkes/munnimok/issues/321)) ([d71b3dc](https://github.com/okkes/munnimok/commit/d71b3dcc1e265fd8311942529eac2a8e29d70666))
* **review:** the wallet deck — parts as toggling cards (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([070c903](https://github.com/okkes/munnimok/commit/070c903f31eec9e8b2cf80f3c96b88bf59bec286))
* **search:** one SearchField everywhere, a special lens, live logos (refs [#234](https://github.com/okkes/munnimok/issues/234) [#245](https://github.com/okkes/munnimok/issues/245) [#246](https://github.com/okkes/munnimok/issues/246) [#258](https://github.com/okkes/munnimok/issues/258)) ([53a948a](https://github.com/okkes/munnimok/commit/53a948a35811f3a750d80c6da14e591009196ddb))
* **server:** consents record their environment (LS4 redirect origin) ([04b0b16](https://github.com/okkes/munnimok/commit/04b0b16b5f935034bb1bcfcdb995f16aa74991ce))
* **settings,spaces:** the settings cluster (refs [#147](https://github.com/okkes/munnimok/issues/147) [#146](https://github.com/okkes/munnimok/issues/146) [#178](https://github.com/okkes/munnimok/issues/178) [#137](https://github.com/okkes/munnimok/issues/137) [#157](https://github.com/okkes/munnimok/issues/157) [#150](https://github.com/okkes/munnimok/issues/150) [#159](https://github.com/okkes/munnimok/issues/159) [#158](https://github.com/okkes/munnimok/issues/158)) ([f26fc90](https://github.com/okkes/munnimok/commit/f26fc90f374bc39e80b386efd85d63fe8538d1e9))
* **settings:** account deletion narrates its progress (refs [#307](https://github.com/okkes/munnimok/issues/307)) ([312de02](https://github.com/okkes/munnimok/commit/312de0214a7ece65028022a702f9a7a59c84187d))
* **sheets:** in-flight work answers the click-away; unexpected answers leave traces (refs [#203](https://github.com/okkes/munnimok/issues/203) [#186](https://github.com/okkes/munnimok/issues/186)) ([6b320b5](https://github.com/okkes/munnimok/commit/6b320b5c3a40d306a8e4927361bea5ba0197194a))
* **social:** profile sheets, one-shot space invites, live members, kick pushes — social board batch (refs [#162](https://github.com/okkes/munnimok/issues/162) [#165](https://github.com/okkes/munnimok/issues/165) [#169](https://github.com/okkes/munnimok/issues/169) [#170](https://github.com/okkes/munnimok/issues/170) [#171](https://github.com/okkes/munnimok/issues/171) [#172](https://github.com/okkes/munnimok/issues/172) [#173](https://github.com/okkes/munnimok/issues/173) [#164](https://github.com/okkes/munnimok/issues/164)) ([47f8c32](https://github.com/okkes/munnimok/commit/47f8c32a39887d1af146c6f34e93b97dcd6b3b99))
* **spaces:** the info sheet shows the global name and doors to it (refs [#239](https://github.com/okkes/munnimok/issues/239)) ([c0b5843](https://github.com/okkes/munnimok/commit/c0b5843d447f214d9efdaf71fb38f8c9e64ca89f))
* **split:** filters see through splits; the card really travels (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([dd11b78](https://github.com/okkes/munnimok/commit/dd11b78b37d99ebe347631fb23bef729614880ea))
* **split:** honest repeats, part spreads, branching list (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([320a082](https://github.com/okkes/munnimok/commit/320a08251a2b956804ba4be783a5640c882bdac2))
* **split:** parts answer filters and search (arc E1) ([fdb27f3](https://github.com/okkes/munnimok/commit/fdb27f34bf2e45e76acb51e757109886a94530c6))
* **split:** parts are full transactions — notes, reimbursements, the card deck (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([90e38ee](https://github.com/okkes/munnimok/commit/90e38ee1d81b5c5826be4ab162b30da489fd6616))
* **split:** parts are sub-transactions — detail flow, drafts, one kind each (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([111c81d](https://github.com/okkes/munnimok/commit/111c81db0866bc163668dbdcae8052ef9348647a))
* **split:** parts are whole transactions, unrestricted (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([9840335](https://github.com/okkes/munnimok/commit/9840335ccef6f885a6dbcbabc9162fb6049ab317))
* **split:** plain multi-category back + per-part spreads + register entry (v2.1) ([8ea29d2](https://github.com/okkes/munnimok/commit/8ea29d28ce74edd1e5960feee13532c4d7f5a2c3))
* **split:** the connected-parts visual language (arc D) ([90a7d6f](https://github.com/okkes/munnimok/commit/90a7d6f430794424184c37197fd67bd908c26680))
* **split:** the flat-loan question + polish (arcs E2+F) ([e12bdac](https://github.com/okkes/munnimok/commit/e12bdac5d9d27e248b0d3cfb2157f172f0af110a))
* **split:** the part page carries the parent's Details card (refs [#199](https://github.com/okkes/munnimok/issues/199)) ([831fdaa](https://github.com/okkes/munnimok/commit/831fdaa1e8782d7261acba3e9a92c1f37b01769b))
* **split:** the two editors explain themselves (refs [#209](https://github.com/okkes/munnimok/issues/209) [#210](https://github.com/okkes/munnimok/issues/210) [#242](https://github.com/okkes/munnimok/issues/242)) ([7204637](https://github.com/okkes/munnimok/commit/7204637bfd1786a2831f671e15f6e3e23da3dd8d))
* **split:** typed parts of one payment — the core (arc C) ([6a0271b](https://github.com/okkes/munnimok/commit/6a0271b8dd091eae2b9235e1c703d554353783fc))
* **sync:** the 24h NEW clock is ONE clock across devices; the camera header stops forbidding the webcam (refs [#148](https://github.com/okkes/munnimok/issues/148) [#160](https://github.com/okkes/munnimok/issues/160)) ([bc8935b](https://github.com/okkes/munnimok/commit/bc8935b5b6622d56a41bad7b1b98b2a50aa96c42))
* **tx:** accounts stamp their rows, transfers mint the counter leg (arc B) ([bf88006](https://github.com/okkes/munnimok/commit/bf880068dbfc973505a5a2b5008985cd7b4ecf80))
* **tx:** category, counterparty and sign become one fact — the movement bijection (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([aaf1f0d](https://github.com/okkes/munnimok/commit/aaf1f0de3095678ae3f77f033111cdb68b5ca77a))
* **tx:** counterparty is a category-level fact — board batch (refs [#138](https://github.com/okkes/munnimok/issues/138) [#153](https://github.com/okkes/munnimok/issues/153) [#197](https://github.com/okkes/munnimok/issues/197) [#217](https://github.com/okkes/munnimok/issues/217) [#218](https://github.com/okkes/munnimok/issues/218) [#219](https://github.com/okkes/munnimok/issues/219) [#220](https://github.com/okkes/munnimok/issues/220)) ([99000b1](https://github.com/okkes/munnimok/commit/99000b10795ef6db1c30cffb3f10b7588221b963))
* **tx:** every category entry answers its own counterparty, at pick time (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([965f695](https://github.com/okkes/munnimok/commit/965f695f576b4c8130bf9c453ec875dde17034e4))
* **tx:** honest unmatched wording, in-picker counter removal, chevron sweep, inset focus rings, firm filtered scroll (refs [#321](https://github.com/okkes/munnimok/issues/321) [#322](https://github.com/okkes/munnimok/issues/322) [#323](https://github.com/okkes/munnimok/issues/323) [#327](https://github.com/okkes/munnimok/issues/327) [#328](https://github.com/okkes/munnimok/issues/328) [#329](https://github.com/okkes/munnimok/issues/329)) ([ef3c36d](https://github.com/okkes/munnimok/commit/ef3c36dcbc32ea5f97c6b17db6d2ba3c430ce8ff))
* **tx:** linking asks first — the match sheet, same-sign wallet pairs, unlink questions (refs [#237](https://github.com/okkes/munnimok/issues/237)) ([ab3a7ec](https://github.com/okkes/munnimok/commit/ab3a7eca8045c2d44432ba91d805cd06a8bd95a5))
* **tx:** one counterparty per (split) transaction — the category redesign (refs [#228](https://github.com/okkes/munnimok/issues/228)) ([1a9a046](https://github.com/okkes/munnimok/commit/1a9a046730eb67571b26bd39cc869f23ec64ccb1))
* **tx:** quieter list, honest selection, a counter lens (refs [#250](https://github.com/okkes/munnimok/issues/250) [#198](https://github.com/okkes/munnimok/issues/198) [#156](https://github.com/okkes/munnimok/issues/156) [#243](https://github.com/okkes/munnimok/issues/243)) ([4074ef8](https://github.com/okkes/munnimok/commit/4074ef8d8e1996ab8c00b7c97c392e18313ab1d1))
* **tx:** retained filters, honest reimbursements, richer detail actions — tx board batch (refs [#140](https://github.com/okkes/munnimok/issues/140) [#148](https://github.com/okkes/munnimok/issues/148) [#181](https://github.com/okkes/munnimok/issues/181) [#201](https://github.com/okkes/munnimok/issues/201) [#213](https://github.com/okkes/munnimok/issues/213) [#216](https://github.com/okkes/munnimok/issues/216) [#232](https://github.com/okkes/munnimok/issues/232) [#233](https://github.com/okkes/munnimok/issues/233) [#231](https://github.com/okkes/munnimok/issues/231) [#255](https://github.com/okkes/munnimok/issues/255) [#260](https://github.com/okkes/munnimok/issues/260)) ([425432a](https://github.com/okkes/munnimok/commit/425432af7e68f8001e7db7a766d11da18164d3c0))
* **tx:** same-day linked legs render as one visual unit ([#352](https://github.com/okkes/munnimok/issues/352)) ([3127c84](https://github.com/okkes/munnimok/commit/3127c84fee3a4cbb06519b287004a9cbcfcfa36d))
* **tx:** split categories get their own field — row.cats joins the model (refs [#211](https://github.com/okkes/munnimok/issues/211)) ([104aaf5](https://github.com/okkes/munnimok/commit/104aaf5797b05c3c440308bfeae42c511d2b8adf))
* **tx:** the counterparty question — Default row, bank badge, pick-existing fork (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([19b00b6](https://github.com/okkes/munnimok/commit/19b00b6f2a61031f9d6d2f92622a24cbdabcd92c))
* **tx:** the detail loses its kind surfaces — the counterparty ask takes over (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([e67ccd6](https://github.com/okkes/munnimok/commit/e67ccd6f681396c7adeab2fbe69816ed1c957536))
* **tx:** the funding pick asks WHICH pot; the bank's counterparty stays visible (refs [#152](https://github.com/okkes/munnimok/issues/152)) ([8921c9a](https://github.com/okkes/munnimok/commit/8921c9a324dbea21530ff73e30778744a27fe18d))
* **tx:** the mandatory transfer ask reaches parts (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([f8749b6](https://github.com/okkes/munnimok/commit/f8749b662c7ea50f7a8b4e7d9c137142a4b8a19e))
* **tx:** the manual form drops the kind grid — counterparty row + Adjustment toggle (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([968b89c](https://github.com/okkes/munnimok/commit/968b89c7af819c5e385d6beb551bc55ec0203686))
* **tx:** the stored transaction type is dead — the view derives everything (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([4b336d5](https://github.com/okkes/munnimok/commit/4b336d505dba53a876c7b071496c7590d1cb9181))
* **tx:** two features, two editors — split categories leaves the split-transaction sheet (refs [#211](https://github.com/okkes/munnimok/issues/211)) ([ff50a68](https://github.com/okkes/munnimok/commit/ff50a68f8703a3e4defd36a8e98aa7575a5791da))
* **tx:** txType retirement step A — derive, defaults, migration (refs [#133](https://github.com/okkes/munnimok/issues/133)) ([de5e521](https://github.com/okkes/munnimok/commit/de5e521993dc733e0e09d397402f9993d83e3b92))
* **ui:** expanded sheets pin the 92 percent fraction of the live viewport (refs [#312](https://github.com/okkes/munnimok/issues/312)) ([c6720ea](https://github.com/okkes/munnimok/commit/c6720ea0f144c5d7c62ce8e2fa61df4aafda8767))
* **ui:** sheet growth paced by the gesture; content-wrapped partials; wide desktop shape (refs [#312](https://github.com/okkes/munnimok/issues/312) [#311](https://github.com/okkes/munnimok/issues/311) [#335](https://github.com/okkes/munnimok/issues/335)) ([7798a13](https://github.com/okkes/munnimok/commit/7798a132d9c84bc4fe985d574eaf925daec88994))
* **ui:** sheets open partial and expand on intent - never shrinking on their own (refs [#312](https://github.com/okkes/munnimok/issues/312)) ([891f571](https://github.com/okkes/munnimok/commit/891f571efc98b297cac1a64f70ec63a22752b726))
* **ux:** dismiss the mobile keyboard on scroll and on Enter ([57e0444](https://github.com/okkes/munnimok/commit/57e0444e55217e5156701df7dd87efab60804073))
* **wizard:** claimed accounts, sign-ins view, stack cleanup, calmer tooling ([96a7f87](https://github.com/okkes/munnimok/commit/96a7f87d0a3372b2a6eb08c596851c9d3aeeb4c0))
* **wizard:** one-button local setup; quiet saves; honest sign-in state ([1b62dd8](https://github.com/okkes/munnimok/commit/1b62dd834834015062c237228055273566d40a5e))
* **wizard:** zero-input GlitchTip, kept inputs, honest EB local story ([f75ec10](https://github.com/okkes/munnimok/commit/f75ec10c7bc6a1a82db244b6c4c43a3bee09fc66))
* **wizard:** zero-input Logto, repo forking, auto branches, GitHub-optional local ([dbbb775](https://github.com/okkes/munnimok/commit/dbbb7755f504cbc5059e73e16022c1e7a20d18b0))


### 🐞 Bug Fixes

* **admin:** bank connections are scoped to THIS environment ([9e719ae](https://github.com/okkes/munnimok/commit/9e719aef1c52a86732cc1c190701a37589dbde5e))
* **api:** sync push retries the concurrent-insert PK race; EB complete idempotent on a burnt code (refs [#281](https://github.com/okkes/munnimok/issues/281)) ([263240b](https://github.com/okkes/munnimok/commit/263240bdff693599d969a140581a31832a4e506c))
* **app:** archived-only shares STAY with their pill — only a dead mirror is a ghost (refs [#288](https://github.com/okkes/munnimok/issues/288)) ([b978e65](https://github.com/okkes/munnimok/commit/b978e6502e0a0ac3412ce9d51f1ff704a16cd26a))
* **app:** checkboxes stop hiding the tab bar; live specs walk the new social UI (refs [#162](https://github.com/okkes/munnimok/issues/162) [#165](https://github.com/okkes/munnimok/issues/165) [#169](https://github.com/okkes/munnimok/issues/169) [#170](https://github.com/okkes/munnimok/issues/170) [#172](https://github.com/okkes/munnimok/issues/172)) ([aaab843](https://github.com/okkes/munnimok/commit/aaab843def688324d78573f2683309d34eb872cd))
* **app:** end segments own their frame corners; upcoming wears the loan account face (refs [#327](https://github.com/okkes/munnimok/issues/327) [#336](https://github.com/okkes/munnimok/issues/336)) ([884f871](https://github.com/okkes/munnimok/commit/884f871c5a0b479a1e587915d5b5f45672645c0c))
* **app:** native user login crashed on the forgotten txSeen entity (refs [#296](https://github.com/okkes/munnimok/issues/296)) ([c2f574a](https://github.com/okkes/munnimok/commit/c2f574acfc425300009fdfd402df05ae0b1c941a))
* **app:** overview period memory, home new-lens rows, funding form, chart width ([#355](https://github.com/okkes/munnimok/issues/355) [#358](https://github.com/okkes/munnimok/issues/358) [#342](https://github.com/okkes/munnimok/issues/342) [#354](https://github.com/okkes/munnimok/issues/354)) ([8536b49](https://github.com/okkes/munnimok/commit/8536b4972f543b7d3a2f414a3869503fc8489e9d))
* **app:** review reset, recurring adoption + door, upcoming days, funding insights ([#340](https://github.com/okkes/munnimok/issues/340) [#360](https://github.com/okkes/munnimok/issues/360) [#357](https://github.com/okkes/munnimok/issues/357) [#347](https://github.com/okkes/munnimok/issues/347) [#356](https://github.com/okkes/munnimok/issues/356)) ([3a4481b](https://github.com/okkes/munnimok/commit/3a4481b5e1faf5e3c2aaaadd5014648b8370bd25))
* **app:** scroll-dismissed keyboards wait for the finger to lift (refs [#312](https://github.com/okkes/munnimok/issues/312)) ([0efaf5b](https://github.com/okkes/munnimok/commit/0efaf5b12b4cf62f6e79b456f736dbb540ecd51e))
* **app:** sign-in failures speak on the login screen; iOS certificate steps corrected everywhere ([08b63f1](https://github.com/okkes/munnimok/commit/08b63f1af4737fc8bd655effaf3404530c6f38e6))
* **app:** the keyboard's goodbye no longer jumps the screen mid-scroll ([#312](https://github.com/okkes/munnimok/issues/312)) ([134d324](https://github.com/okkes/munnimok/commit/134d324aa0599ff4d22cdf529e7244b134fe253c))
* **auth:** a dead refresh grant names itself and heals (refs [#222](https://github.com/okkes/munnimok/issues/222)) ([6eb33b3](https://github.com/okkes/munnimok/commit/6eb33b3e02f1ec8941156ae47baeb7f0f1ff8850))
* **categories:** uncategorized is gray by design, at the source ([#353](https://github.com/okkes/munnimok/issues/353)) ([8d99c82](https://github.com/okkes/munnimok/commit/8d99c82f4d70c87a6c5ba3bfdca39cf3a3d38fce))
* **cats:** the five-story investment family and the loan-only value picks (refs [#252](https://github.com/okkes/munnimok/issues/252)) ([e31ae67](https://github.com/okkes/munnimok/commit/e31ae67f1e354422344e36ef3986cbd41b35bc22))
* **ci:** one Apple signing certificate per team, checked before every iOS build ([59272b5](https://github.com/okkes/munnimok/commit/59272b5dd781bba23fa12e50f7f1565548fd1f8c))
* **debts:** the match footer speaks one type voice (refs [#286](https://github.com/okkes/munnimok/issues/286)) ([00b61ff](https://github.com/okkes/munnimok/commit/00b61ffe7934b980df9f9240b6a9bdf82a7339e5))
* **deploy:** every deploy is new to the poller — the stamp is &lt;sha&gt;.&lt;run number&gt; ([a63b50c](https://github.com/okkes/munnimok/commit/a63b50ca8f6d125d22ef8338122bf33335018617))
* **deploy:** http deployments admit their API origin in img-src ([031189d](https://github.com/okkes/munnimok/commit/031189d01549e13ee0d6338dbf5530b03069ec4a))
* **deploy:** the 17→18 migration reads the old volume's PG_VERSION — the IaC twins keep 18 data in a volume named pgdata ([dc21a64](https://github.com/okkes/munnimok/commit/dc21a640a24f88f8608c24320a5e9a6ca28ca7f8))
* **events:** the attach screen seeds its picks in the same commit as its rows (refs [#144](https://github.com/okkes/munnimok/issues/144)) ([4235fc3](https://github.com/okkes/munnimok/commit/4235fc3c1db17abc33beb522dc701ee84c661504))
* **gc:** an empty backfill keeps asking — the stamp no longer buries PayPal (refs [#240](https://github.com/okkes/munnimok/issues/240)) ([3f58550](https://github.com/okkes/munnimok/commit/3f585502e40f9fb6aa2eb30c11e03875c7619d79))
* **gc:** EB rows without identity survive; wallet feeds follow the newest consent (refs [#240](https://github.com/okkes/munnimok/issues/240)) ([8f19be5](https://github.com/okkes/munnimok/commit/8f19be5467d6db6ecd022069c4198c793f6e8389))
* **gc:** staging offers both providers; the admin provider toggle retires (refs [#175](https://github.com/okkes/munnimok/issues/175)) ([5938c77](https://github.com/okkes/munnimok/commit/5938c77e50be9455a103d4435dc5ea0f9d3caff5))
* **home:** safe-to-spend converts like every other band mode ([#349](https://github.com/okkes/munnimok/issues/349)) ([1c549f6](https://github.com/okkes/munnimok/commit/1c549f6a865c0545392c6642d6872c9868c5be3c))
* **home:** tab returns render instantly - remount cache + one-shot fade ([#361](https://github.com/okkes/munnimok/issues/361)) ([c6aaf16](https://github.com/okkes/munnimok/commit/c6aaf167305e38aac2a6b301b0b7961e7dd3894e))
* **home:** the debts block drops its see-all ([#337](https://github.com/okkes/munnimok/issues/337)) ([bf65d2e](https://github.com/okkes/munnimok/commit/bf65d2eebd4e2bdaabf7057f5c16834ab2613be3))
* **import:** say the history story out loud (refs [#177](https://github.com/okkes/munnimok/issues/177)) ([2beac25](https://github.com/okkes/munnimok/commit/2beac250a2ecae2aaa1fae3672fe3b0975ff4a74))
* **infra:** a cleanup puts the current poller script on the NAS before its "remove" stamp, and the poller handles "remove" before its nothing-new shortcut ([2e57fa1](https://github.com/okkes/munnimok/commit/2e57fa1cf5f56c19cb8a9ac2f45b74855e98a6d5))
* **infra:** a Let's Encrypt request is waited out, every host decides the certificate, and Bootstrap runs only once its secrets exist ([4a7e053](https://github.com/okkes/munnimok/commit/4a7e05328170abee812d89dc6a4bb0b4c4c66a4f))
* **infra:** a missing file in the live dir is DSM's HTML error page, not content ([dd28077](https://github.com/okkes/munnimok/commit/dd28077d6fe1daef548415bce09c30b9d4c222c7))
* **infra:** a reverse-proxy rule's id is UUID on DSM 7.3 — every rule collapsed onto one map key, so one of seven got bound ([7abee50](https://github.com/okkes/munnimok/commit/7abee50671b4bbb14ef6f4952b59f0825705dfc6))
* **infra:** a root poller task is deleted through its owner API, and a cleanup copes with a live dir or environment that is already gone ([799db31](https://github.com/okkes/munnimok/commit/799db31ad817ff4f793d80606321d7c6b6a92045))
* **infra:** a Task Scheduler entry is deleted with tasks=[{id, real_owner}] on SYNO.Core.TaskScheduler v4 — DSM 7.3's own words ([de4fdab](https://github.com/okkes/munnimok/commit/de4fdabb41ccd4b22d087122e105413fd8c0145b))
* **infra:** Actions-pipeline reset fallback in the copy wait; pre-created store records are the whole manual step ([dacfe76](https://github.com/okkes/munnimok/commit/dacfe7642ccd75e882aeb5491e1b1f4b2544f36c))
* **infra:** an App ID pasted as the Apple client id is named as such; Apple's own message rides along ([d6a8a03](https://github.com/okkes/munnimok/commit/d6a8a035730d09135252db2947c521f4814fd030))
* **infra:** bootstrap adopts a hand-made poller only for its own live dir — one for another dir is another pipeline's and stays untouched ([07a08bd](https://github.com/okkes/munnimok/commit/07a08bd6104ddb952d4d99547d08ea0e200f0b80))
* **infra:** control origin passes api CORS; automatic network mode; vault notes; stale-token 401 message ([13a12c0](https://github.com/okkes/munnimok/commit/13a12c0913467d7d039033da50c6534169ed4164))
* **infra:** copies sync their whole infra tree per branch; verify names a certificate that misses a host ([36f398c](https://github.com/okkes/munnimok/commit/36f398c17237aae0f0f9df3f4e30194a03f84ea6))
* **infra:** copy flow never pauses Actions; migrate container folded away; delete tolerates a dead repo; re-trust after full delete ([e86ac7b](https://github.com/okkes/munnimok/commit/e86ac7b48ccd21edd2c3d242783ec3f4f675db08))
* **infra:** credential checks work with zero environments; helper errors name themselves ([4198113](https://github.com/okkes/munnimok/commit/41981130e5d10ceff8f40c7f541658087702e695))
* **infra:** Deploy to NAS names every secret it passes — no toJSON(secrets), the pattern GitHub held every deploy for since 2026-09-08 ([822db68](https://github.com/okkes/munnimok/commit/822db6894771f2e4dd5cdb127e2f577f1d8e1611))
* **infra:** double-started helper points at the running one instead of crashing ([835e7db](https://github.com/okkes/munnimok/commit/835e7db2da9ebe9785ca86c95f99aa23abeee60c))
* **infra:** env create/delete under LAN refreshes the family Caddyfile + restarts the https proxy ([599de8d](https://github.com/okkes/munnimok/commit/599de8d93bc57945e417b98dc7a5efed268c919a))
* **infra:** Firebase push names the real gap - Service Usage Admin, not Firebase Admin ([918685a](https://github.com/okkes/munnimok/commit/918685ad82ca01e8759ac2c50d31708f84f583fb))
* **infra:** fresh-family setup works from an empty registry ([24d1312](https://github.com/okkes/munnimok/commit/24d1312387ec3d7558c4ed3f6131dc4bbd0ef6da))
* **infra:** GlitchTip admin email leaves .local; desktop CA trust; env delete purges the GlitchTip org ([124486d](https://github.com/okkes/munnimok/commit/124486dbc7fc28f8a0e9ab686165f751f3829429))
* **infra:** helper auto-claim reads the m-admin secret bare; valid app-admin username ([c5fb98c](https://github.com/okkes/munnimok/commit/c5fb98c0f6cca7a88c321771fa53582dc5b034a9))
* **infra:** iOS build flow speaks on its card and opts the repo in ([d584b01](https://github.com/okkes/munnimok/commit/d584b01dd6f530313833634c6456e08edb441bd2))
* **infra:** LAN flip renders shared first so DSNs pick the new address ([7258ae6](https://github.com/okkes/munnimok/commit/7258ae6b1904d39b63bafc2ac6ddc980e1cb23a1))
* **infra:** live app-id labels per selected env; 403 store checks name the real problem ([a27b5c8](https://github.com/okkes/munnimok/commit/a27b5c86ea99bf842f34300a153d31c6653d5761))
* **infra:** local builds version by seconds-since-2026 — commit counts collide at Play ([4d8959c](https://github.com/okkes/munnimok/commit/4d8959cdc6da1b4b667476cd50c695a25baf7b74))
* **infra:** never cache repo sealing keys — recreated repos mint new ones ([94487ea](https://github.com/okkes/munnimok/commit/94487ea10e04c1484a7a531c0e44cfe07317defd))
* **infra:** pin postgres:18.6-alpine everywhere a stack renders it ([eb55aea](https://github.com/okkes/munnimok/commit/eb55aea88db76c1caf3a0941f13de445f3a53602))
* **infra:** reality-first wiring gates; GitHub connect joins step 3; vault stays on localhost ([6a2fc2e](https://github.com/okkes/munnimok/commit/6a2fc2edc2326e1ca6d5aad36df0a80faee4aa7d))
* **infra:** repo-scope secret path, blocked-fetch diagnosis, Play guide reality, copy-wave damping ([78a6d31](https://github.com/okkes/munnimok/commit/78a6d311592374c200c3da2387e9c5efbd92f249))
* **infra:** sign-in logo survives Logto CSP on http stacks (data URIs) ([8f7d1e1](https://github.com/okkes/munnimok/commit/8f7d1e132815e9e9f07d204cb6854bf6019ea18e))
* **infra:** social connectors keep their fixed ids; Sign in with Apple is registered as the primary App ID ([c7ebbd1](https://github.com/okkes/munnimok/commit/c7ebbd15b787a457a5b05aeb475fec575decbab7))
* **infra:** step-3 Save works with zero environments - stack fallbacks stop naming a phantom prod ([8fcd002](https://github.com/okkes/munnimok/commit/8fcd002e349a9cbc18991d3017fc11b82fd0e89d))
* **infra:** the DSM login names no session — "Core" is refused with 402 for every account on DSM 7.3.2 ([ac23be6](https://github.com/okkes/munnimok/commit/ac23be63c62f58c2f54f68719725d7622c538845))
* **infra:** the DSM login takes DSM 7's path (entry.cgi), and verify compares sessions made both ways ([115dbce](https://github.com/okkes/munnimok/commit/115dbce3408bc82e3def1bf5aeeb8fa3f0cab4f1))
* **infra:** the File Station upload carries the session's SynoToken — DSM answered 119 to the poller script on the first real run ([4987fb9](https://github.com/okkes/munnimok/commit/4987fb9841a51dc9096dfd803455c26ffadf6e24))
* **infra:** the GlitchTip block's environment name survived the Logto rewrite — infraEnv is defined again ([10fa470](https://github.com/okkes/munnimok/commit/10fa470e54f9df9cbefba7a708b1d3f0c857ac5c))
* **infra:** the live deploy job skips green in a repository without the live channel's secrets ([3c9da22](https://github.com/okkes/munnimok/commit/3c9da22b6aceb099885e4366a3a2a7a76474e938))
* **infra:** the login asks for the SynoToken in the URL too, and verify names whether DSM issued one and which call shapes it reads ([eb40d0c](https://github.com/okkes/munnimok/commit/eb40d0cd42c163841107128f4a5254d83d5b9007))
* **infra:** the poller task's delete sweeps the versions of both task APIs — DSM 7.3 answers 103 to the two forms tried so far ([25dbd0e](https://github.com/okkes/munnimok/commit/25dbd0e1fdddddc9b6a49ba5b3a0d70e5467c95c))
* **infra:** the push story moves next to the apps it depends on ([63e9b65](https://github.com/okkes/munnimok/commit/63e9b65aad47f61cf86aead60de6bc2c0683decc))
* **infra:** the runbook artifact is uploaded before the chain step, never lost to a failed dispatch ([76cb0ee](https://github.com/okkes/munnimok/commit/76cb0ee4f1ca6a47ca04b7c74ad7d121ee79ccfa))
* **infra:** the sid and the SynoToken ride the query string and the X-SYNO-TOKEN header — DSM 7.3 answers 119 to a body-only sid ([6d7dcf3](https://github.com/okkes/munnimok/commit/6d7dcf3142e5c8ffca80977d381090eeab15812a))
* **infra:** the stored push sender reaches the api; Firebase apps carry the track in their names ([bf5d67f](https://github.com/okkes/munnimok/commit/bf5d67fab70b2aa26e886d3fbca17a0fa7d3b22e))
* **infra:** the task delete sweeps SYNO.Core.TaskScheduler downwards with DSM's tasks=[{id, real_owner}] shape — v4 has no delete ([98be057](https://github.com/okkes/munnimok/commit/98be057277aff3d1c0e5a3d50f1edbb2047d6e75))
* **infra:** verify names the login shapes DSM accepts when the bootstrap login is refused ([0fb2e69](https://github.com/okkes/munnimok/commit/0fb2e695147b30154315cdd0bc599a3f05824c28))
* **input:** defer the focus-empty one frame — the iOS caret stall (refs [#134](https://github.com/okkes/munnimok/issues/134)) ([9e32b00](https://github.com/okkes/munnimok/commit/9e32b00dba178c6567b632ab1680a543b37b8d7d))
* **input:** iOS keeps native tap-to-focus in sheets — the caret stall (refs [#134](https://github.com/okkes/munnimok/issues/134)) ([42f30e5](https://github.com/okkes/munnimok/commit/42f30e5cbf9b90138baf176769f1c231ad659603))
* **ios:** fields the keyboard swallowed scroll back into view (refs [#129](https://github.com/okkes/munnimok/issues/129)) ([6fe0d22](https://github.com/okkes/munnimok/commit/6fe0d22259c498688a5d63e28299cac9a6cf6489))
* **lock:** one passkey prompt per lock cycle, and the PIN dismisses it (refs [#202](https://github.com/okkes/munnimok/issues/202)) ([5a96c7b](https://github.com/okkes/munnimok/commit/5a96c7bb12c3b72863e5148983230ad7eeb31fa9))
* **login:** dark-mode top scrim over the light hero art (refs [#122](https://github.com/okkes/munnimok/issues/122)) ([dbe794b](https://github.com/okkes/munnimok/commit/dbe794b2e95217ecedc6f2482d613ea723271376))
* **mina,cats:** the glow respects the sheet stack; no stale error flash (refs [#136](https://github.com/okkes/munnimok/issues/136) [#247](https://github.com/okkes/munnimok/issues/247)) ([03c8c3a](https://github.com/okkes/munnimok/commit/03c8c3ad591991b047b908ed50143e4865444e37))
* **money:** a currency-less balance drops the literal XXX (refs [#254](https://github.com/okkes/munnimok/issues/254)) ([dcdb9b4](https://github.com/okkes/munnimok/commit/dcdb9b4cd86cea7146ba761928d0bba18322a51d))
* **reimb:** a split expense links per PART — the root is never a target (refs [#197](https://github.com/okkes/munnimok/issues/197)) ([7fa0d42](https://github.com/okkes/munnimok/commit/7fa0d42fa9b4f7d19114327fc182c521b0f6fafe))
* **reimb:** container links settle the expecting part first (refs [#235](https://github.com/okkes/munnimok/issues/235)) ([1071097](https://github.com/okkes/munnimok/commit/1071097de4a6e06822a2c793a8498526e2dfe7f7))
* **review:** the debt row retires — the counterparty row already names it (refs [#236](https://github.com/okkes/munnimok/issues/236)) ([dbf06d3](https://github.com/okkes/munnimok/commit/dbf06d313105bbd14a237ee50767415df872ee76))
* **sheets:** stacked sheets become siblings — children painted BELOW their parent (refs [#241](https://github.com/okkes/munnimok/issues/241)) ([8e657a5](https://github.com/okkes/munnimok/commit/8e657a56e36013e2d277fef8900cab60b91c44d0))
* **spaces:** the start date governs on every device (refs [#259](https://github.com/okkes/munnimok/issues/259)) ([fc9650c](https://github.com/okkes/munnimok/commit/fc9650c7bfb0cdc9a9af63b0838caf7066e5ea81))
* **split:** exact-euros splits bulk-reach only same-amount siblings (refs [#141](https://github.com/okkes/munnimok/issues/141)) ([29d5faa](https://github.com/okkes/munnimok/commit/29d5faa7fefd2706853012cb0c69fbb596f8db16))
* **split:** left-to-assign fills the row being worked on (refs [#130](https://github.com/okkes/munnimok/issues/130)) ([ea260c7](https://github.com/okkes/munnimok/commit/ea260c7986d107084960c802c01e6d1ba102e76b))
* **split:** own card in lists, slimmer container page, part rename (refs [#126](https://github.com/okkes/munnimok/issues/126)) ([01c9716](https://github.com/okkes/munnimok/commit/01c97167da96fa1e2a285abf5934dfbce974db88))
* **split:** part rows carry the date where plain rows do (refs [#143](https://github.com/okkes/munnimok/issues/143)) ([4f3aac0](https://github.com/okkes/munnimok/commit/4f3aac06531af61aeac2854541d12f96a5984354))
* **split:** parts are the unit everywhere — branch, select, bulk-copy (refs [#139](https://github.com/okkes/munnimok/issues/139), [#141](https://github.com/okkes/munnimok/issues/141), [#143](https://github.com/okkes/munnimok/issues/143), [#149](https://github.com/okkes/munnimok/issues/149)) ([bcf1cf4](https://github.com/okkes/munnimok/commit/bcf1cf405143a7b9019c549fcd51d34629db915c))
* **split:** the container's parts section goes plain — no spine, no Edit, rows open their part (refs [#200](https://github.com/okkes/munnimok/issues/200)) ([e1fc1a4](https://github.com/okkes/munnimok/commit/e1fc1a41b4f63c5dfff4131a3a5b3a3a9dfe9e0e))
* **split:** the pill fills the field it was tapped from (refs [#130](https://github.com/okkes/munnimok/issues/130)) ([490c228](https://github.com/okkes/munnimok/commit/490c2281ea0a35fba1a84b6f475d2627dad103a2))
* **sync:** push-403 is not eviction - readers park writes; evictions tombstone once (refs [#306](https://github.com/okkes/munnimok/issues/306)) ([b55ac36](https://github.com/okkes/munnimok/commit/b55ac36870eb58ed619f5b104299b35f6a9082b0))
* **sync:** the pull PAGES until drained — the head cursor was eating every op past 1000 (refs [#305](https://github.com/okkes/munnimok/issues/305)) ([722ced9](https://github.com/okkes/munnimok/commit/722ced95dfa2ebf4f18d490ba82e967ae3075aed))
* **tx:** a predicted transfer names a real account or stands down (refs [#228](https://github.com/okkes/munnimok/issues/228)) ([9d4e332](https://github.com/okkes/munnimok/commit/9d4e332a565b452141c44fd2fec820739a8d6f44))
* **tx:** Done closes the split-categories editor (refs [#211](https://github.com/okkes/munnimok/issues/211)) ([200292d](https://github.com/okkes/munnimok/commit/200292d609a736f66779f0af30409ed21975a571))
* **tx:** idle rows carry no radius - the divide-y hairline stays straight (refs [#198](https://github.com/okkes/munnimok/issues/198)) ([04698e3](https://github.com/okkes/munnimok/commit/04698e3337f555716279d2b434354a693b53277c))
* **tx:** pairs land two-way — the overlay reciprocal, spoken-for rows, counterpart records, review picks first (refs [#237](https://github.com/okkes/munnimok/issues/237)) ([93f7cb0](https://github.com/okkes/munnimok/commit/93f7cb085f6f568234b586f48a0bd94cdbc9ef36))
* **tx:** reimbursement stays on the split, and the card owns the counterparty (refs [#228](https://github.com/okkes/munnimok/issues/228)) ([f35a7f5](https://github.com/okkes/munnimok/commit/f35a7f5c49978c77e5796e836ffa5ab95a211cd9))
* **tx:** the single real account still picks itself beside the cash wallet ([#348](https://github.com/okkes/munnimok/issues/348)) ([f1003eb](https://github.com/okkes/munnimok/commit/f1003ebc078eb7cda92fa675864cac4e9b467031))
* **ui:** a dirty sheet's drag completes — hide, ask, and come back on cancel (refs [#253](https://github.com/okkes/munnimok/issues/253)) ([06aeb1b](https://github.com/okkes/munnimok/commit/06aeb1b6718ec4c190ba5fe5834d4cd5c361066f))


### ⏪ Reverts

* **ui:** the sheet experience returns to its pre-[#312](https://github.com/okkes/munnimok/issues/312) state; scroll-dismissal scopes to search (refs [#312](https://github.com/okkes/munnimok/issues/312)) ([c8aad3f](https://github.com/okkes/munnimok/commit/c8aad3f9e186ed76f606c1d115f42fce5dbc920a))

## [2.27.0](https://github.com/okkes/munnimok/compare/v2.26.0...v2.27.0) (2026-08-02)


### ✨ Features

* **accounts:** device-batch 2 — counterparty create door, space-accounts redesign, Mina wrap fix ([fece21a](https://github.com/okkes/munnimok/commit/fece21a9a34fb4036f4cc6ab361b2af66ff5e647))
* **accounts:** edit manual accounts in place, choose the balance sign, account picker field ([784bc92](https://github.com/okkes/munnimok/commit/784bc924ec0c5e8a753d67ab1766564fb1843f68))
* **accounts:** name the two account screens by scope (arc 9) ([ad82cdb](https://github.com/okkes/munnimok/commit/ad82cdb979a46dd21d3ac8cc69a96ea97214e335))
* **auth:** multiple offline profiles + Mina's second-world ask (arc 8) ([398aecb](https://github.com/okkes/munnimok/commit/398aecb6c497afff4f5895fdcb2d28252ce81610))
* **cats:** locked transfer-family doors with sign-picked subs (arc 2 core) ([498d274](https://github.com/okkes/munnimok/commit/498d27473d5d05f4de6adeff15687cfd0be24426))
* **cats:** the "no counter account" exit + family-sub back-fill (arc 2 finish) ([191eb87](https://github.com/okkes/munnimok/commit/191eb87597d7e22b51913480b17aa67fb99e2598))
* **debts:** loans v2 — the liability account IS the debt ([f8ad48b](https://github.com/okkes/munnimok/commit/f8ad48b3be29fe6950c377482c08e973403915df))
* **debts:** merged Loan form, payment cadence + estimates, unassigned bucket (arc 3) ([a03839a](https://github.com/okkes/munnimok/commit/a03839a558a2af46f1f18f6c3005ecabdd07b384))
* **loans:** balance coupling + payment matching; band modes; tutorial and desktop fixes ([c09994b](https://github.com/okkes/munnimok/commit/c09994b24c19957f237a3eadcdd8bef348c5befc))
* **notifs:** in-app notifications center + bell badge (arc 6) ([22b74ee](https://github.com/okkes/munnimok/commit/22b74eee67a084302adebc2eb3e160722019b955))
* **recurring:** detection reads past the start date; 2-year bank history; GlitchTip triage ([accbae1](https://github.com/okkes/munnimok/commit/accbae1e281dd455c28bdbfc8d0686e13820c7cf))
* **spaces:** full create form + private invite lock (arc 4) ([a5570eb](https://github.com/okkes/munnimok/commit/a5570ebc2970bcabc7bbf6be43a6752ed6cb7f14))
* **spaces:** per-space attention pills + avatar dot (arc 7) ([66f554e](https://github.com/okkes/munnimok/commit/66f554e6c53b815ca7df3029df8683d3b9e2bcf0))
* **spaces:** start-date mechanics — gate, counted moves, refusal (arc 5) ([9344b6d](https://github.com/okkes/munnimok/commit/9344b6dc998d806a4638768cf220208abd4dc4e7))
* **tx:** the FUNDING type - money to/from another space's pot ([42950c7](https://github.com/okkes/munnimok/commit/42950c73db9f9030e79795d938ce07eba79a9f11))
* **tx:** the pair is ONE row - collapse, mirror write, peer row, unpair (arc 1) ([9eebded](https://github.com/okkes/munnimok/commit/9eebdedc04a9062406fe46793bb33563d313a09a))
* **tx:** transfer legs pair up - the matcher spans spaces (arc 1 slice 1) ([bc69c2b](https://github.com/okkes/munnimok/commit/bc69c2bba895f0d928d3f12edb10b9501113a93b))
* **ux:** device-batch 2026-07-29 - debt surfaces, handoff ask, tour hardening ([b70b4d6](https://github.com/okkes/munnimok/commit/b70b4d68b2e3569792e109e237bfe75aa6cffb04))


### 🐞 Bug Fixes

* **app:** device-batch 3 — sign-safe predictions, wheel gesture, dirty guard, Mina locks ([83d5d6f](https://github.com/okkes/munnimok/commit/83d5d6fef7036e74ee99eb9c433c2ad6ed80efe5))
* **auth:** never wipe fresh Logto keys after login; self-heal tokenless 401s ([1ac2fc6](https://github.com/okkes/munnimok/commit/1ac2fc6a3f1698a3af58e93fcb314c734de91ae6))
* **core:** device-batch 1 — start-date gate on imports, funding as transfer member, debt catalog, sheet gestures ([6346d21](https://github.com/okkes/munnimok/commit/6346d21cda4b7d11f5b5ddb34c910fc734e19260))
* **mina:** pick-step double-advance, sheet-closed self-heal, glow travel; weekly nudge throttle ([15bf084](https://github.com/okkes/munnimok/commit/15bf084d204c9763e522463ed2a4b8e86788316a))
* **tx:** release the transfer peer from the store, not the live snapshot ([dc839c6](https://github.com/okkes/munnimok/commit/dc839c6f1daebd65ef54fc7f5ed63295fb04561f))
* **ux:** list sheets drag via header only; iOS keyboard slack; search reveal tuning ([3309733](https://github.com/okkes/munnimok/commit/3309733eb7d396884682db8381bc965f6988827a))

## [2.26.0](https://github.com/okkes/munnimok/compare/v2.25.0...v2.26.0) (2026-07-28)


### ✨ Features

* **accounts:** mirror server-side space links the client never saw ([df68e25](https://github.com/okkes/munnimok/commit/df68e2584320a989350131f53739e2750a692cb6))
* **accounts:** the global overview says where every account lives ([8ce46f8](https://github.com/okkes/munnimok/commit/8ce46f8a9efabedcc9fc937cc529a9b3138a2615))
* **debts:** a debt is always backed by a loan account ([6385f58](https://github.com/okkes/munnimok/commit/6385f58e673b3a37191dbf9a6ffd43b554c084cc))
* **debts:** payments derive from the backing account; weekly rate nudge ([b362f62](https://github.com/okkes/munnimok/commit/b362f62962190bf993fd72b0bb781a261824574c))
* **debts:** the recurring form's Debt kind hands off into debt creation ([f25378e](https://github.com/okkes/munnimok/commit/f25378e2e1f16aa7b6e7f48e1a7a8b9a1d450a08))
* **recurring:** recurring costs own a category and re-file their transactions ([600fb12](https://github.com/okkes/munnimok/commit/600fb125876487c53daa85c23f0c08b7c3d68f56))
* **recurring:** the category lock reaches review, detail and linking ([10fd3ec](https://github.com/okkes/munnimok/commit/10fd3ec1acd20eae52e52ba6a2f3e04bc964ea8e))
* **tx:** full account setup door in the transfer counterparty picker ([7186e40](https://github.com/okkes/munnimok/commit/7186e40d6658a5c419bd185c00e20927d4e675aa))


### 🐞 Bug Fixes

* **accounts:** import preview matches manual accounts again + e2e follows the space door ([b611435](https://github.com/okkes/munnimok/commit/b611435b94a82698d55225b5ffe554a1ec6decec))
* **mina:** onboarding-kill dormancy, cleanup rework, rounded instant shade ([08e10f4](https://github.com/okkes/munnimok/commit/08e10f4e4af567b043b31764a32e132ea70d5b31))
* **sonar:** unnest diagnose template literals, cover the probe path ([984c539](https://github.com/okkes/munnimok/commit/984c53918a2528e61096a59d2d18c5eeb83ee3e2))

## [2.25.0](https://github.com/okkes/munnimok/compare/v2.24.0...v2.25.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* **ui:** replace vaul with react-modal-sheet as the sheet engine

### ✨ Features

* **mina:** design pass from the first device run -- glow, travel, no overlap ([0e9e227](https://github.com/okkes/munnimok/commit/0e9e227eb5eb54dc75cf13c143318feea4d4d017))
* **mina:** retire the welcome tour, help-index replay, Mina test suite ([5e0e52f](https://github.com/okkes/munnimok/commit/5e0e52f1fc21241b26f3be22e99d80af8477225d))
* **mina:** tutorial engine + no-space first-run (M1-M4 core) ([d231e56](https://github.com/okkes/munnimok/commit/d231e56248b4a46e8c3fb00e970591db49426b3f))
* **tx,review,ui:** device-run batch 3 -- reimb link screen, iOS fixes, invariants ([d94ec8a](https://github.com/okkes/munnimok/commit/d94ec8a803b482eaae5fade6687e992a92a7f5ee))
* **tx:** simplified kinds -- standard / transfer / adjustment ([756e351](https://github.com/okkes/munnimok/commit/756e351666eaaef540a96129247e4b8b6029bb29))


### 🐞 Bug Fixes

* **deps:** update android minor & patch ([#104](https://github.com/okkes/munnimok/issues/104)) ([a1a0887](https://github.com/okkes/munnimok/commit/a1a088788aacad50acd524fb8afc953b232e3fb2))
* **mina,review,ui:** quick batch 4 + v2.25.0 what's new ([7b377ff](https://github.com/okkes/munnimok/commit/7b377ff5ff5f184cafd0224e882981a0ea29b0fe))
* **mina,tx,ui:** second device-run batch -- resume, act race, reimburse rules ([6ec7014](https://github.com/okkes/munnimok/commit/6ec70148057f1c3c0d326446345f80f2551c9678))
* **mina:** publish the space-name suggestion synchronously ([f260158](https://github.com/okkes/munnimok/commit/f260158498b0a9a73dab181e4174953dec84cc32))
* **mina:** re-entrant bootstrap ambush + e2e passage through the tutorial ([9b2e930](https://github.com/okkes/munnimok/commit/9b2e930ea0c4e6fe1b84eab11d7a44729145f1fb))
* **mina:** teach space switching from Home, not the manage screen ([b118483](https://github.com/okkes/munnimok/commit/b1184830de2661a1c7d8efc3340542e1731bb3ac))
* **sync,ui:** import purge race (DATA LOSS) + sheet/dialog structural fixes ([db7e7ec](https://github.com/okkes/munnimok/commit/db7e7ec25280babde8e80ded0aaace51a4aa727e))
* **ui:** open sheets to their full height on iOS (WebKit flex basis) ([afc8a84](https://github.com/okkes/munnimok/commit/afc8a8476c5e9548a7e220ed21647f7a83ee5177))
* **ui:** open sheets to their full height on iOS (WebKit flex collapse) ([4dde757](https://github.com/okkes/munnimok/commit/4dde757bd28553de35f2fb9d442a803a02cf444a))


### 🧹 Chores

* pin the next release to 2.25.0 ([25208e4](https://github.com/okkes/munnimok/commit/25208e422c2bd6a9f3c8cef2f681059fa501066e))


### ♻️ Refactoring

* **ui:** replace vaul with react-modal-sheet as the sheet engine ([ee6cff0](https://github.com/okkes/munnimok/commit/ee6cff05e9df287606bd08e884ad231065669091))

## [2.24.0](https://github.com/okkes/munnimok/compare/v2.23.0...v2.24.0) (2026-07-25)


### ✨ Features

* **accounts:** import batches with uploader attribution + per-batch rollback; master plan ledger ([1fccf5d](https://github.com/okkes/munnimok/commit/1fccf5d3fbb5d01d6acb0b3121529a34eabecc6a))
* **accounts:** imported-vs-linked reconciliation -- the connection is the truth ([3b8f263](https://github.com/okkes/munnimok/commit/3b8f26394e5ae8fb509805c50475fd2a89d1cc13))
* **accounts:** say where imported data ENDS, not just when it arrived ([1633f26](https://github.com/okkes/munnimok/commit/1633f26abf88bfd73322ed8a16568853510c4022))
* **activity:** complete the space history — every user mutation logs ([bedc473](https://github.com/okkes/munnimok/commit/bedc4731ed5032b2e5775d6574e816587139b3a8))
* **cats:** locked reimbursement tree -- step 1 of the reimbursement redesign ([7e59591](https://github.com/okkes/munnimok/commit/7e5959152e5646db323fbd4edf7373313b31a962))
* **cats:** restore the pre-replacement drag-to-move design ([4364e0c](https://github.com/okkes/munnimok/commit/4364e0c1870e5d8b4f4040858a73a205872391ac))
* **devices:** logged-in devices -- see, rename, remotely disconnect (wipe) ([541a390](https://github.com/okkes/munnimok/commit/541a390e4f43d04d16e5834a7b3d1ee404f0af41))
* **help:** guided welcome walkthrough -- real screens, real writes, act-steps ([599980e](https://github.com/okkes/munnimok/commit/599980e6654cc9ea764c62f8412138a3a7bb21dc))
* **reimburse:** keep the locked tree out of budget/trends pickers; guide mentions the redesign ([33dd5c7](https://github.com/okkes/munnimok/commit/33dd5c75df74b81e7d5c41c3a66f4df347b49244))
* **reimburse:** settled value becomes an explicit `reimbursed` slice -- redesign steps 2-5 ([018571d](https://github.com/okkes/munnimok/commit/018571d99fffddfc69601fd6216e36cead2a6c78))
* **sheets:** gesture plan phases A+B + desktop grow-from-source dialog ([2f8c4f3](https://github.com/okkes/munnimok/commit/2f8c4f3fdb93e889d3e7627f6e9f513dcdd3a14b))
* **statements:** PayPal activity-export importer + speak-up apply cycles ([3b5bc55](https://github.com/okkes/munnimok/commit/3b5bc55d0c579ea6f89bf5f7900df5f84dcbe811))
* **sync:** client-server version handshake -- refuse to sync across a contract mismatch ([24b9c19](https://github.com/okkes/munnimok/commit/24b9c19f888f1ec83bcc03c5bb86e7220af04d0c))
* **ui:** edge-swipe back, drag-linked sheet zoom, sticky sheet drags, animated overview bar ([d3ec081](https://github.com/okkes/munnimok/commit/d3ec081ad64217776a51277b11fb7062acfa406d))


### 🐞 Bug Fixes

* **api,accounts:** attach raced its check-then-insert; import button now guards double-taps ([d15fb05](https://github.com/okkes/munnimok/commit/d15fb05e043af4e08e0fbeb07074397fb27ea720))
* **api,app:** import failures root-caused + feedback batch ([fdb6e13](https://github.com/okkes/munnimok/commit/fdb6e1300d27633d7c3b60b30a32d6e214b8863a))
* **api:** explicit ordinal already-lowercase check (CA1862) ([dc0ac6b](https://github.com/okkes/munnimok/commit/dc0ac6b564938e34d35726a0751e4c80e957ba32))
* **app:** hoist the device-revoked wipe handler (S2004 nesting) ([3011edb](https://github.com/okkes/munnimok/commit/3011edb7bb90d2c90893a2816d1335573bf35d81))
* **deploy,sheets:** staging stamp used master SHA; restore the touch guard our keyboard fix disabled ([1aa6ab5](https://github.com/okkes/munnimok/commit/1aa6ab5927129250011d0c72ef4daa9b3f7ba240))
* **deploy:** stamp NAS bundles with the image-building commit, not the default-branch tip ([#100](https://github.com/okkes/munnimok/issues/100)) ([1a5a0c3](https://github.com/okkes/munnimok/commit/1a5a0c3146e2d2d95e08b0b425044e23f46ca413))
* **tests:** valid AccountSource in batch-rollback seed ([81aceb5](https://github.com/okkes/munnimok/commit/81aceb58c5e93f65987f7d70440bfac9538a8bb6))

## [2.23.0](https://github.com/okkes/munnimok/compare/v2.22.0...v2.23.0) (2026-07-24)


### ✨ Features

* **recurring:** the amount is the user's — drift becomes a one-tap recommendation ([c5c2c62](https://github.com/okkes/munnimok/commit/c5c2c62e602adc362f73740d7a2a7f06aa6b9703))
* **tx:** quick-add prefill + reliable auto-link; multi-file imports; patient e2e onboarding wait ([4acaa42](https://github.com/okkes/munnimok/commit/4acaa42d094ca7b248090a6da03d6f3a6b95ab34))


### 🐞 Bug Fixes

* **e2e:** 240s budgets for every multi-user spec — cold-stack double onboarding outlives 120s ([7a9c19f](https://github.com/okkes/munnimok/commit/7a9c19fb87afa7876e85bd1c674d7b30c94b51fb))
* **e2e:** deterministic onboarding wait in the shared base() helper ([7481eec](https://github.com/okkes/munnimok/commit/7481eec04ade82a8a8f8e50712638cf6a7d26b0f))
* **e2e:** fill-until-armed onboarding passage — a fill racing first hydration under CPU starvation left the field empty and the click waiting forever ([1ce9be4](https://github.com/okkes/munnimok/commit/1ce9be4f815c3ca0040e003a28818ec14846c1a1))
* **e2e:** race onboarding vs home in base() — cold-start first paint outlived the 3s guess ([9f07467](https://github.com/okkes/munnimok/commit/9f07467578972f5de2e6cb33d6e53e7bac572825))
* **e2e:** the onboarding race keyed on the WRONG signal — tab bar lives outside DataProvider ([81ff54e](https://github.com/okkes/munnimok/commit/81ff54e8e5db87ea193c2da512024415009c63b8))
* **perf:** one shared display-currency lens (per-row hooks melted sync-time perf); iOS uploads always run, daily cap degrades to a warning ([4868b62](https://github.com/okkes/munnimok/commit/4868b62ca7ffd4fa383c3ec1471601b41f0053a7))

## [2.22.0](https://github.com/okkes/munnimok/compare/v2.21.0...v2.22.0) (2026-07-24)


### ✨ Features

* **accounts:** AE1+AE3 — the one intent-routed Add-account chooser everywhere ([97ac745](https://github.com/okkes/munnimok/commit/97ac7457cb6decda20cf5c8d81578df9383b12fa))
* **accounts:** three account tiers — manual tx only on manual accounts, space-scoped creation, provenance labels ([a7eddaf](https://github.com/okkes/munnimok/commit/a7eddaf7b6ede99c66fa378882f31b3dea6b95b7))
* activity history prunes 200 rows or 90 days; onboarding country defaults from IP for signed-in users ([48b59b9](https://github.com/okkes/munnimok/commit/48b59b96f11c010e24a26f32acd7e605e6b49f8c))
* **activity:** per-space action history — last 200 who-did-what rows in the bell ([1f847f8](https://github.com/okkes/munnimok/commit/1f847f829e1723c8d813650f160d41af7e8f2f40))
* **auth:** go-offline always deletes server data (login survives), remote-wipe for other devices; danger zone moves to profile ([81852fa](https://github.com/okkes/munnimok/commit/81852fa8b0ebb28be383a6895840489b590ca71b))
* **auth:** offline profile can be deleted — data, lock config and registry, danger-confirmed ([170793b](https://github.com/okkes/munnimok/commit/170793b26e54678a1411a6e17298e41d9c99b11f))
* **auth:** online → offline conversion — identity rebind, consent screen, manual-tier flip (OO1-OO4) ([0ec7429](https://github.com/okkes/munnimok/commit/0ec74299e7eda4c5bfd030a53cd7e83465dcff70))
* **cats:** drag-to-move restored — custom subs drag onto another main with ghost + target highlight ([bfbca86](https://github.com/okkes/munnimok/commit/bfbca86dc71aa39a41c88c29ba576e902001dc60))
* **currency:** CD4 — lens across all money surfaces + band quick toggle; AE2 attach offer; AE4 vocabulary ([9adab43](https://github.com/okkes/munnimok/commit/9adab43b0aea5bad7b9ea36d43bd74c73aac85ab))
* **currency:** display-currency lens — ECB rates, user-level preference, ≈ everywhere it converts ([b15505e](https://github.com/okkes/munnimok/commit/b15505ebdfc51efadb6c8d8343389b92676e54ba))
* **encryption:** E3a cipher proof + verify probe, E3b encrypted-by-default for fresh native installs ([ae0a13a](https://github.com/okkes/munnimok/commit/ae0a13a4be9ec4538801cb19f1e4b022a247267f))
* **encryption:** E4 — SQLCipher always-on for native, Dexie copy-migration; Sonar hotspots resolved; green see-all ([de20bb5](https://github.com/okkes/munnimok/commit/de20bb57b37978ccb362c2ba78f848ef379b70fa))
* **help:** space-accounts tutorial — three account tiers, slides + live walkthrough ([8f96887](https://github.com/okkes/munnimok/commit/8f96887d63fe68260b225f2205439edf3d1938de))
* **import:** ING exports fully supported — bilingual, all five shapes, balance files, format picker ([13d152e](https://github.com/okkes/munnimok/commit/13d152e1bcf0e6c2fba4e82046ae4e56d5e52309))
* **infra:** domain as secret, Logto social connectors as code, baby-steps README, secrets-access plan ([305c787](https://github.com/okkes/munnimok/commit/305c787022c68aaad4965f30b83cd5f02681aa19))
* **infra:** DSM v7 auth with SynoToken; cert automation settles on acme.sh synology_dsm hook ([76ac147](https://github.com/okkes/munnimok/commit/76ac147f98019287ed1b38480549df5bfefa1db4))
* **infra:** IaC runs in GitHub Actions + DSM reverse proxy as code ([2bb2318](https://github.com/okkes/munnimok/commit/2bb23185ea3276cae0c112c4e67dc265f1fcb336))
* **infra:** Logto sign-in screen branded as code — munni logo + brand color ([cc44d61](https://github.com/okkes/munnimok/commit/cc44d61e33bc5cfbd845e63805af1998aab72d6f))
* offline two-step screens + single profile, activity actor names, detach-loss warning, account currency pick ([a4590bf](https://github.com/okkes/munnimok/commit/a4590bf949ae501994f1f59c2b12fdb9b0c32971))
* **onboarding:** one first-run setup for online AND offline — profile, language, country of use, avatar, lock ([8fc3311](https://github.com/okkes/munnimok/commit/8fc3311598f4ea88785b0ba27c708fa75bcf30c2))
* **settings:** restructure settings — space card header, profile to global, period/currency/history as own settings ([a7737fe](https://github.com/okkes/munnimok/commit/a7737fe309714c0723a7fd7d3c1c7ac6d644cb6a))
* **tx:** manual add uses the SAME unified category editor as review ([13b03ff](https://github.com/okkes/munnimok/commit/13b03ff81b66c3f7e47cb77b4b52d9b54a1c3e82))
* **ui:** offline country-flag icons for language and country fields ([0f33fe2](https://github.com/okkes/munnimok/commit/0f33fe25d442ddef74f90ab514f878a66c4a0284))
* **ui:** stacked sheets step down in height, recede releases instantly, category Save is sticky ([5245576](https://github.com/okkes/munnimok/commit/52455765307824ab08dd458590fb429120c90702))


### 🐞 Bug Fixes

* **ci:** commit the workspace lockfile for flag-icons ([5b293ea](https://github.com/okkes/munnimok/commit/5b293eaab99cc960e7d65f7341dc28b82b2cd2d6))
* **ci:** iOS uploads only from master/dispatch (Apple daily cap); self-heal the NAS apply lock ([8a023b6](https://github.com/okkes/munnimok/commit/8a023b6b24321efb0c741096ab6aeb15ed1e1a11))
* **db:** serialize SQL transactions — SQLCipher choked on concurrent Repo writes ([71bb04f](https://github.com/okkes/munnimok/commit/71bb04fa444087d3670c039edba7626ea0cb298d))
* **e2e:** align gallery specs with danger sheets, rich demo and onboarding lock; feat(auth): offline intro is a full screen ([ae471a3](https://github.com/okkes/munnimok/commit/ae471a323f792d82ea48d3a106a5c65fb3d730bd))
* **e2e:** base() completes the non-skippable onboarding for fresh users ([8170d8e](https://github.com/okkes/munnimok/commit/8170d8ec2547abda57fee9cb00d27e908afae7c9))
* **platform:** universal-link handling drops the hardcoded host pin ([01e4933](https://github.com/okkes/munnimok/commit/01e4933a41bf3ffaefb92df3e5324e70cd33f269))
* **platform:** universal-link hosts derive from publicOrigin — foreign hosts still refused ([9ba3234](https://github.com/okkes/munnimok/commit/9ba323434ed63348868153259feed4c6d5ae585f))
* **review:** split editor seeds the draft category, rows removable in review, bulk skips skipped, main+sub shown; feat(cats): soft-drinks sub + Other-income rename ([8bfe156](https://github.com/okkes/munnimok/commit/8bfe1567ca9879fff5f63e0b21fbe1b769595af3))
* **sync:** quarantine 400-rejected ops instead of wedging the space ([c9cdd24](https://github.com/okkes/munnimok/commit/c9cdd24bb53985321a5c35d68d9df25c45d672bf))
* **tests:** CategoryPicker suite follows the unified editor; add-form picker filters by direction only ([d95b348](https://github.com/okkes/munnimok/commit/d95b3488b2ba22e218c5c387e1b82484b14e8205))
* **ui:** sheets show stack depth and stop Safari paint glitches on grown content ([e6f0bb5](https://github.com/okkes/munnimok/commit/e6f0bb5e3911a6b0a1f5a20be0e5efd3358fbcde))

## [2.21.0](https://github.com/okkes/munnimok/compare/v2.20.1...v2.21.0) (2026-07-22)


### ✨ Features

* **accounts:** delete connected accounts with a revoke-mine-only cascade ([82a3443](https://github.com/okkes/munnimok/commit/82a34431638d85634fef63418ba0a7552a43f385))
* **accounts:** per-space attach/detach with start date, last-sync + reconnect hint ([406502d](https://github.com/okkes/munnimok/commit/406502d071f28dd11e31866cf7973b7d84f18d61))
* **demo:** six months of coherent history + a bulk-review pile ([ec11021](https://github.com/okkes/munnimok/commit/ec110213eb913f82c70c8127584dcef97de781a7))
* **icons:** local icon segment leads and survives online results ([215424b](https://github.com/okkes/munnimok/commit/215424bbedfa4bf87f1acc9fe07a6a8a881ebda0))
* **receipts:** R9 — admin-curated store merchant patterns feed the matcher ([48d83c7](https://github.com/okkes/munnimok/commit/48d83c79704800ff1ff2e84eb31c1ef965ce0316))
* **receipts:** v3 foundation — instance connections, global store feed, snapshot links ([ba21a53](https://github.com/okkes/munnimok/commit/ba21a532cdb063213ce92b3895f260c24d500077))
* **receipts:** v3 migration + receipts screen filters + one attach flow ([588a2f4](https://github.com/okkes/munnimok/commit/588a2f4aa25bd14536340dc811bd50de4242b12d))
* **review:** counterparty and type join the category editor ([738085c](https://github.com/okkes/munnimok/commit/738085cbda4f04a138cbc82ca952896c6a681818))
* **settings:** three-state appearance control; counterparty label ([84435b2](https://github.com/okkes/munnimok/commit/84435b25915ea7bbd7943ae42b453dbd3b5aa3ad))
* **tx:** live manual balances, guarded split editor, no-account flow, Bank-linked label ([2b562e0](https://github.com/okkes/munnimok/commit/2b562e0a0e918bad741dc67e1e8c1323d7b1c175))
* **ux:** budget period bars + filters + days-left, drag-reorder customize sheets, store-sync explainer ([0fcc776](https://github.com/okkes/munnimok/commit/0fcc776b709231891159865500d7585619cfa054))
* **ux:** direct counter/type pickers on detail, aligned danger sheets, tour and label fixes ([447e92e](https://github.com/okkes/munnimok/commit/447e92e3ee165e40818a24b3e290579cebf1f469))
* **ux:** drag v2 with ghost + slide animation (arrows retired); days-to-reset on Home and budgets list ([041397a](https://github.com/okkes/munnimok/commit/041397a06dfac73939653cecf012de47c0eb209c))


### 🐞 Bug Fixes

* **accounts:** icon picks show live in AttachSheet; bank sync no longer clobbers renames ([cd7846b](https://github.com/okkes/munnimok/commit/cd7846b652054a27fcff2eabd54cbbef5a0cfab4))
* **demo:** pin the MEI money cluster out of the current month ([f39b79e](https://github.com/okkes/munnimok/commit/f39b79e535894c924bfe04543c04d8f5b9245fda))
* **deploy:** munni dev Play signing key in assetlinks; stale apply locks self-heal ([212570f](https://github.com/okkes/munnimok/commit/212570f127190124a84e12379b3803f36ca37680))
* **native:** hosted /native-auth bounce follows the channel scheme; review card sheds duplicate rows ([72a42e6](https://github.com/okkes/munnimok/commit/72a42e67cc1afb237f13f553da04914591ad5010))
* **native:** one universal-link domain per channel — dev logins stop opening prod ([b46a3fe](https://github.com/okkes/munnimok/commit/b46a3feb21f74a8f52f9f18da58a6ba062ea9644))
* **ui:** release stuck press state after long-press context menu ([7310a23](https://github.com/okkes/munnimok/commit/7310a2321903c9bf95aba60c5b2766e4e17b6da6))
* **ux:** encrypted-store re-enable, lang popover dismiss, unique private names, onboarding lock step ([c2ce662](https://github.com/okkes/munnimok/commit/c2ce6625d1c38874a4ddad5c8ddeac122ba58325))

## [2.20.1](https://github.com/okkes/munnimok/compare/v2.20.0...v2.20.1) (2026-07-19)


### 🐞 Bug Fixes

* **sync:** unclog poisoned outboxes — accept topics + composite ids, chunk pushes, isolate space failures ([7cea99f](https://github.com/okkes/munnimok/commit/7cea99f813440db14acf2fa06b2a994449a1bf64))

## [2.20.0](https://github.com/okkes/munnimok/compare/v2.19.1...v2.20.0) (2026-07-19)


### ✨ Features

* **app:** recurring set-asides + allocation topics, admin facelift, PSD2 architecture dossier ([76115ff](https://github.com/okkes/munnimok/commit/76115fffcec17793fba83e9cb9c75b251b4f92d7))

## [2.19.1](https://github.com/okkes/munnimok/compare/v2.19.0...v2.19.1) (2026-07-19)


### 🐞 Bug Fixes

* **auth:** stay signed in across app updates ([fe5beea](https://github.com/okkes/munnimok/commit/fe5beea2b6e15520678669dd28366fa18eb69324))

## [2.19.0](https://github.com/okkes/munnimok/compare/v2.18.1...v2.19.0) (2026-07-19)


### ✨ Features

* **app:** split editor says Done, removing a member asks first ([ec37993](https://github.com/okkes/munnimok/commit/ec3799374d908406c107bd48cf6d064df742ba0f))

## [2.18.1](https://github.com/okkes/munnimok/compare/v2.18.0...v2.18.1) (2026-07-19)


### 🐞 Bug Fixes

* **app:** family-account consent safety, staging keeps the shared identity, FCM errors name themselves ([003b653](https://github.com/okkes/munnimok/commit/003b6537084ad684b295a68ee9eda29d0ef6c0cd))

## [2.18.0](https://github.com/okkes/munnimok/compare/v2.17.0...v2.18.0) (2026-07-19)


### ✨ Features

* **app:** left-space cleanup, duplicate-consent convergence, diagnosis names the bound consent ([eac496d](https://github.com/okkes/munnimok/commit/eac496dfed8191519d29dab28e480af053e7ad59))

## [2.17.0](https://github.com/okkes/munnimok/compare/v2.16.0...v2.17.0) (2026-07-18)


### ✨ Features

* **app:** revive the service worker, visible native pushes, steadier sheets and review ([c31715e](https://github.com/okkes/munnimok/commit/c31715ed228be8bd0362cc2add18738b973a856e))

## [2.16.0](https://github.com/okkes/munnimok/compare/v2.15.0...v2.16.0) (2026-07-18)


### ✨ Features

* **app:** quota-proof bank linking with consent healer, token single-flight, goal covers ([8277889](https://github.com/okkes/munnimok/commit/82778894732d3fa920e231a0c2fede1f3227e13f))

## [2.15.0](https://github.com/okkes/munnimok/compare/v2.14.0...v2.15.0) (2026-07-18)


### ✨ Features

* **app:** goal pictures, admin sync-chain diagnosis, event date-input fix, TestFlight update link ([8011e42](https://github.com/okkes/munnimok/commit/8011e4268271d78e373ae5e84260613da091bfa1))

## [2.14.0](https://github.com/okkes/munnimok/compare/v2.13.1...v2.14.0) (2026-07-18)


### ✨ Features

* **review:** the review workbench — every decision editable on a compact card, with create-and-return flow ([13762f0](https://github.com/okkes/munnimok/commit/13762f0114fd4789eb0e20ad0ac92e41a4f541d1))

## [2.13.1](https://github.com/okkes/munnimok/compare/v2.13.0...v2.13.1) (2026-07-18)


### 🐞 Bug Fixes

* **banking:** relay Enable Banking's own error text; rename sheet stays on screen under the iOS keyboard ([e1254f9](https://github.com/okkes/munnimok/commit/e1254f900e70ddce45b1977de41bd942580aac69))

## [2.13.0](https://github.com/okkes/munnimok/compare/v2.12.2...v2.13.0) (2026-07-18)


### ✨ Features

* **app:** universal links + detail/categories polish ([b00347d](https://github.com/okkes/munnimok/commit/b00347d6cddb7b7ce84d89d893fea966754e9df7))

## [2.12.2](https://github.com/okkes/munnimok/compare/v2.12.1...v2.12.2) (2026-07-18)


### 🐞 Bug Fixes

* **banking:** EnableBanking signing key survives its transient client; profile avatar survives reinstall ([594311b](https://github.com/okkes/munnimok/commit/594311bb94cc0613b8bc13f1434fb479b904c5ea))

## [2.12.1](https://github.com/okkes/munnimok/compare/v2.12.0...v2.12.1) (2026-07-18)


### 🐞 Bug Fixes

* **auth:** self-heal the password-change sign-in loop ([a60266a](https://github.com/okkes/munnimok/commit/a60266a8a010b43ec2fd7cc399f2ce3c39b8de85))
* **observability:** institutions failures self-diagnose; sync stops reporting identity states ([ec8be18](https://github.com/okkes/munnimok/commit/ec8be1801dee63e4f79a0966ab7efcd366103003))

## [2.12.0](https://github.com/okkes/munnimok/compare/v2.11.0...v2.12.0) (2026-07-18)


### ✨ Features

* **app:** observability + transaction-detail batch — GC complete idempotency, API Sentry, title renames with memory ([2956d00](https://github.com/okkes/munnimok/commit/2956d0069d13d3490c6cb7f7bceabab038654aaa))

## [2.11.0](https://github.com/okkes/munnimok/compare/v2.10.0...v2.11.0) (2026-07-18)


### ✨ Features

* **app:** motion + control batch — animated folds and panes, uncategorized gate, vendored bank logos ([683f068](https://github.com/okkes/munnimok/commit/683f068a08c11925c2df11f3c10d38e14e23e904))

## [2.10.0](https://github.com/okkes/munnimok/compare/v2.9.0...v2.10.0) (2026-07-18)


### ✨ Features

* **app:** reported-bugs batch, part 2 — review deck + detail control ([0401e11](https://github.com/okkes/munnimok/commit/0401e113a9c018b9db813b4833cf27cc4441e39f))


### 🐞 Bug Fixes

* **app:** the reported-bugs batch, part 1 ([a6ddd17](https://github.com/okkes/munnimok/commit/a6ddd1772afca2be92dbdeecd18db9a27056a00f))

## [2.9.0](https://github.com/okkes/munnimok/compare/v2.8.0...v2.9.0) (2026-07-17)


### ✨ Features

* **shopsync:** E2EE store-connection sync — SC1-SC3 complete ([8c173bb](https://github.com/okkes/munnimok/commit/8c173bb1915336ad7a9873bfd825c8822b57cd8b))


### 🐞 Bug Fixes

* **native:** flows return to the app — GC consent, sign-out, encrypted-store safety ([b9522fc](https://github.com/okkes/munnimok/commit/b9522fc612f6ca1c1870e9d366814131b66b31f8))

## [2.8.0](https://github.com/okkes/munnimok/compare/v2.7.0...v2.8.0) (2026-07-17)


### ✨ Features

* **paypal:** PP1 — funding debits become transfers, purchases count once ([9f1f4c5](https://github.com/okkes/munnimok/commit/9f1f4c5a71e86a4ec5e4a5d6259c29e6ab2f393b))

## [2.7.0](https://github.com/okkes/munnimok/compare/v2.6.0...v2.7.0) (2026-07-17)


### ✨ Features

* **admin:** AC2 — the catalog editor ([8e3a859](https://github.com/okkes/munnimok/commit/8e3a8597fd27c11b66e4d5e4b7412b11b68a860b))
* **catalog:** AC3 — tombstone detach on devices + baked offline baseline ([c401f8a](https://github.com/okkes/munnimok/commit/c401f8ad169d9b0b3724dab9804b4ac17a5cf2f6))

## [2.6.0](https://github.com/okkes/munnimok/compare/v2.5.0...v2.6.0) (2026-07-17)


### ✨ Features

* **ux:** calm categories, honest desktop, visible demo — the review batch ([61ac458](https://github.com/okkes/munnimok/commit/61ac45802107da5aa721f29423ac6822d432cd47))


### 🐞 Bug Fixes

* **deploy:** always capture logto logs in the status dump ([76c4fd0](https://github.com/okkes/munnimok/commit/76c4fd03c8697f5c7d69c3c55c0791eb40a80520))
* **deploy:** restore against the REAL postgres 18, verify before the marker ([1383bd1](https://github.com/okkes/munnimok/commit/1383bd151d35782e491fccda4195a8f3c9e0f7de))
* **deploy:** restore postgres 18 BEFORE dependents boot; redo raced migrations ([762b8af](https://github.com/okkes/munnimok/commit/762b8af71260a50fc697e77c3906949ae34401ad))
* **deploy:** run logto alterations BEFORE the seed (restored 1.24 schema) ([c0dea10](https://github.com/okkes/munnimok/commit/c0dea1026306321c3630fba9cc5dfc36a91d1724))

## [2.5.0](https://github.com/okkes/munnimok/compare/v2.4.0...v2.5.0) (2026-07-17)


### ✨ Features

* **catalog:** AC1 — operator-published catalog document, end to end ([c5aead6](https://github.com/okkes/munnimok/commit/c5aead608d41c5e2e2ad9e4da1ea2edc24910bb2))


### 🐞 Bug Fixes

* **catalog:** published keyword rules merge in front of the bundled set ([3caa2f6](https://github.com/okkes/munnimok/commit/3caa2f63a241d7adaeb25ccf370f6a38aef6b0dd))

## [2.4.0](https://github.com/okkes/munnimok/compare/v2.3.0...v2.4.0) (2026-07-17)


### ✨ Features

* **deploy:** logto 1.41 + postgres 18 with a self-migrating update path ([5a23b29](https://github.com/okkes/munnimok/commit/5a23b29000d33a04d58c1695903cdca59e145c81))
* **tx+acct:** manual-transaction upgrades, account identity controls, clean native sign-out ([798d5a7](https://github.com/okkes/munnimok/commit/798d5a7abdb33909d7bd289edb5399a8f079faa1))

## [2.3.0](https://github.com/okkes/munnimok/compare/v2.2.0...v2.3.0) (2026-07-17)


### ✨ Features

* **db:** E2 — SQLCipher store live behind the native dev flag ([9244c76](https://github.com/okkes/munnimok/commit/9244c76d581eb531e44487b887ea0d413065fa33))


### 🐞 Bug Fixes

* **deploy:** pin logto's self-fetch to the host gateway (admin console 403) ([71b4cc0](https://github.com/okkes/munnimok/commit/71b4cc0a2e4230b2f34243dded33c522568da1f1))
* **push:** guard the webview's phantom serviceWorker; drop pure network noise from telemetry ([9d4e926](https://github.com/okkes/munnimok/commit/9d4e926692bab7d8acb7d1c34cc6e5f7902b4196))

## [2.2.0](https://github.com/okkes/munnimok/compare/v2.1.0...v2.2.0) (2026-07-17)


### ✨ Features

* **db:** E2 groundwork — SQL storage backend with backend-parity suite ([16ac565](https://github.com/okkes/munnimok/commit/16ac5658789e8a2180c31e75a7a70841a9a1a900))


### 🐞 Bug Fixes

* **deps:** commit the workspace lockfile for the sql.js/dexie-react-hooks swap ([899ffef](https://github.com/okkes/munnimok/commit/899ffef1c8cf30eeed339d9b56698e6384f3929c))
* **review:** reset the fresh-card state during render, not in a late effect ([85a2d8c](https://github.com/okkes/munnimok/commit/85a2d8c86db7245bb5acd65d0135d2b49e8e0f7d))

## [2.1.0](https://github.com/okkes/munnimok/compare/v2.0.0...v2.1.0) (2026-07-17)


### ✨ Features

* **review+tx:** the recovered redesign batch — type-first card, one editor, richer bulk, detail bulk-apply ([3b6c1d2](https://github.com/okkes/munnimok/commit/3b6c1d2a4d03157e1bc472d42f1a805e95ec99f4))

## [2.0.0](https://github.com/okkes/munnimok/compare/v1.24.0...v2.0.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* **deps:** Capacitor 8 across the shells + valkey 9

### ✨ Features

* **review:** one category editor + transactions-style bulk sheet (user redesign) ([d3fe7c9](https://github.com/okkes/munnimok/commit/d3fe7c9ef259d420e335e02bf46cb35d251e340e))
* **tx+cats:** remarks batch 2 — editable counterparty + retro-linking, category naming rules, fixes ([3c0661e](https://github.com/okkes/munnimok/commit/3c0661eee577be2bdb2c783915fca90dc7977f3c))


### 🐞 Bug Fixes

* **native:** minSdk 24 — Capacitor 8's camera library floor (Android 7) ([a148ede](https://github.com/okkes/munnimok/commit/a148edea04a400465bc5cdcaf8e71236e6256b12))


### 🧹 Chores

* **deps:** Capacitor 8 across the shells + valkey 9 ([3c0758b](https://github.com/okkes/munnimok/commit/3c0758b6933c40114052d69ed0a7e8c1dfe5e9f4))

## [1.24.0](https://github.com/okkes/munnimok/compare/v1.23.0...v1.24.0) (2026-07-16)


### ✨ Features

* **native:** §5 niceties — haptics, share-sheet exports, launcher shortcuts, push-tap routing ([f227fed](https://github.com/okkes/munnimok/commit/f227fedaf89efc753091849a3957f3c81dfbcb96))


### 🐞 Bug Fixes

* **ci:** BSD base64 reads stdin only ([4d58dde](https://github.com/okkes/munnimok/commit/4d58dde8f368499d706cb5a35cfa1f1029f2b05e))
* **ci:** clear existing Development certs before minting the persistent one ([0f2dff5](https://github.com/okkes/munnimok/commit/0f2dff5870685b2eb1601d333236633c8852adb8))
* **ci:** legacy PBE for the minted p12 — Apple's security tool can't read OpenSSL 3 defaults ([639909f](https://github.com/okkes/munnimok/commit/639909f1f5a188a5ec4a950302c8cac864f5622f))
* **ci:** mint the p12 on macOS and import-verify it in the same run ([b6a0a43](https://github.com/okkes/munnimok/commit/b6a0a43e8fff86c0dd00c122b13dcb53b4d67b33))

## [1.23.0](https://github.com/okkes/munnimok/compare/v1.22.0...v1.23.0) (2026-07-16)


### ✨ Features

* **ui+review:** remarks batch — headers, splits placement, Home block, own-transfer detection ([7121c2c](https://github.com/okkes/munnimok/commit/7121c2c9d088f1bec2b70ee35459a9e0241ae76c))

## [1.22.0](https://github.com/okkes/munnimok/compare/v1.21.0...v1.22.0) (2026-07-16)


### ✨ Features

* **native:** §1 biometrics — the OS Face ID / fingerprint prompt unlocks the app lock ([7188405](https://github.com/okkes/munnimok/commit/7188405abe1bdd4c5bdac72c03037016f1f66dab))


### 🐞 Bug Fixes

* **build:** tolerate a missing patch-package in scoped installs ([f1eb4ce](https://github.com/okkes/munnimok/commit/f1eb4ce73e83fc0feb71976b72bd288862cd9205))
* **native:** patch the biometric plugin's gradle for AGP 9 ([4d1590e](https://github.com/okkes/munnimok/commit/4d1590e7c7661d387701a9c5f33436abfafe546a))

## [1.21.0](https://github.com/okkes/munnimok/compare/v1.20.0...v1.21.0) (2026-07-16)


### ✨ Features

* **splits:** SP5 — event link, auto-attach, event summary, settlement review chip ([cc3e61b](https://github.com/okkes/munnimok/commit/cc3e61b5644f1aac97c3a3a19bc9d723effb24c6))

## [1.20.0](https://github.com/okkes/munnimok/compare/v1.19.0...v1.20.0) (2026-07-16)


### ✨ Features

* **splits:** SP4 — settle in one tap + owner-only close ([fa73b2a](https://github.com/okkes/munnimok/commit/fa73b2aa1b5ebd6c8214c71c614bb147d7881457))

## [1.19.0](https://github.com/okkes/munnimok/compare/v1.18.0...v1.19.0) (2026-07-16)


### ✨ Features

* **native:** real Firebase iOS config for app.munni.dev (staging push) ([0e44b2d](https://github.com/okkes/munnimok/commit/0e44b2d1b146af03da78aa1a2fdfc00e04f64b88))
* **splits:** SP3 — share-link invites, join screen, guest hardening + tour ([66fa5fe](https://github.com/okkes/munnimok/commit/66fa5fe6ad92a8e95a7ef255bbe301525ebdaae7))

## [1.18.0](https://github.com/okkes/munnimok/compare/v1.17.0...v1.18.0) (2026-07-16)


### ✨ Features

* **native:** real Firebase iOS config for app.munni (push delivery) ([8b83703](https://github.com/okkes/munnimok/commit/8b83703eba9f8c50e4003840d3ffbfc3e1a9e738))
* **splits:** SP1 — split sessions with membership-scoped ledger ([00f6ca5](https://github.com/okkes/munnimok/commit/00f6ca526d3067c65a97d53b55fcf54cbb944045))
* **splits:** SP2 — add expenses from your own transactions + share editor ([89e3025](https://github.com/okkes/munnimok/commit/89e30251a82f355cb060fbe89448f7d1f55f86d9))


### 🐞 Bug Fixes

* **app:** local-first startup — never block a returning device on the network ([7e3cabc](https://github.com/okkes/munnimok/commit/7e3cabc2f1b5248e236a101ac2dcbdeb5f38a97a))
* **native:** iOS push registration + staging icon + persistent signing cert ([1f3cc7b](https://github.com/okkes/munnimok/commit/1f3cc7b11bc5a12397b461027d95c2dd4cdaf258))
* **ui:** snap the shell back when iOS keyboard focus-scroll displaces it ([30659f6](https://github.com/okkes/munnimok/commit/30659f659c4480bfb62a8af82845321248a6d495))

## [1.17.0](https://github.com/okkes/munnimok/compare/v1.16.0...v1.17.0) (2026-07-16)


### ✨ Features

* **account:** full account deletion (design delivered) ([5b44921](https://github.com/okkes/munnimok/commit/5b44921b46305c59cfb560736b685764296407d6))

## [1.16.0](https://github.com/okkes/munnimok/compare/v1.15.0...v1.16.0) (2026-07-16)


### ✨ Features

* **admin:** desktop console redesign - grants, quota, overview (AD1-3) ([e6e1462](https://github.com/okkes/munnimok/commit/e6e14620d3e69175406ee22c6c71b4de535633c6))

## [1.15.0](https://github.com/okkes/munnimok/compare/v1.14.0...v1.15.0) (2026-07-16)


### ✨ Features

* **native:** update card, follow-device pickers, camera receipts, tx type row ([e7598aa](https://github.com/okkes/munnimok/commit/e7598aa8fb437fb50ff3885a858061fe61bf023c))

## [1.14.0](https://github.com/okkes/munnimok/compare/v1.13.0...v1.14.0) (2026-07-16)


### ✨ Features

* **ux:** native post-logout deep link; bank-details block; What's New catch-up; splits + admin redesign docs ([b311a4d](https://github.com/okkes/munnimok/commit/b311a4db871c4f461d03f6aedf17cc52d085d58c))

## [1.13.0](https://github.com/okkes/munnimok/compare/v1.12.0...v1.13.0) (2026-07-15)


### ✨ Features

* **native:** SDK 36; i18n review fixes NL+TR; account-deletion plan ([4ee2959](https://github.com/okkes/munnimok/commit/4ee2959e7915b18e9017f9dc6d85fd355ebcc891))


### 🐞 Bug Fixes

* **ci:** prune iOS dev certs by keep-newest-3, not derived age ([220094a](https://github.com/okkes/munnimok/commit/220094aedc0f7f5fc5443f792638939199f41ea7))
* **deploy:** allow native webview origins in the api CORS lists ([5398666](https://github.com/okkes/munnimok/commit/5398666d8bc60c70a52edfb461f826da3464e69f))

## [1.12.0](https://github.com/okkes/munnimok/compare/v1.11.0...v1.12.0) (2026-07-15)


### ✨ Features

* **tx:** reimbursements physically rewrite category attribution; device language on first run ([8924c7e](https://github.com/okkes/munnimok/commit/8924c7ee43cec45ba4db3304fce2831bdd3b6dd7))

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
