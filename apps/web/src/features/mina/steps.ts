import type { TranslationKey } from '@/i18n';
import type { MinaArt, MinaExpr } from './assets';

/**
 * The Mina onboarding tutorial (docs/mina-onboarding-tutorial.md):
 * auto-starts after the onboarding form, walks the REAL navigation via
 * gated clicks, and never writes data — the user's own form submissions
 * complete the act-steps (store-diff detection, value-flexible).
 */

/** entities the act-steps watch and the revert ledger tracks */
export type MinaEntity = 'space' | 'account' | 'transaction';

export interface MinaStep {
  /** stable id — resume + tests key on it */
  id: string;
  /** fullscreen Mina page vs the small bubble beside the action */
  kind: 'fullscreen' | 'bubble';
  /** bubble avatar / fullscreen art */
  expr?: MinaExpr;
  art?: MinaArt;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** route this step plays on; missing = wherever the user is */
  screen?: string;
  /** highlighted testids ('$s1'/'$s2' resolve to the run's created
   *  spaces); several candidates cover mobile vs desktop nav */
  anchor?: string[];
  /** gate: the anchor is the ONLY tappable element; tapping it advances */
  gate?: boolean;
  /** info highlight: anchor shown but inert — Next advances */
  info?: boolean;
  /** completes when a NEW row of this entity exists (deleted: absent) */
  act?: { entity: MinaEntity; absent?: boolean };
  /** form prefill suggestion while this step is live (localized name key) */
  suggestKey?: TranslationKey;
}

export const MINA_STEPS: readonly MinaStep[] = [
  { id: 'welcome', kind: 'fullscreen', art: 'greeting', titleKey: 'mina.welcome.t', bodyKey: 'mina.welcome.b' },
  { id: 'home', kind: 'bubble', expr: 'smile', titleKey: 'mina.home.t', bodyKey: 'mina.home.b', screen: '/home' },
  { id: 'spaces', kind: 'fullscreen', art: 'spaces', titleKey: 'mina.spaces.t', bodyKey: 'mina.spaces.b' },
  { id: 'sharing', kind: 'fullscreen', art: 'family', titleKey: 'mina.sharing.t', bodyKey: 'mina.sharing.b' },
  { id: 'openSwitcher', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.firstSpace.t', bodyKey: 'mina.openSwitcher.b', screen: '/home', anchor: ['home-space-switcher'], gate: true },
  { id: 'openManage', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.firstSpace.t', bodyKey: 'mina.openManage.b', anchor: ['space-pick-manage'], gate: true },
  { id: 'openCreate', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.firstSpace.t', bodyKey: 'mina.openCreate.b', anchor: ['spaces-add'], gate: true },
  { id: 'createSpace', kind: 'bubble', expr: 'thinking', titleKey: 'mina.firstSpace.t', bodyKey: 'mina.createSpace.b', act: { entity: 'space' }, suggestKey: 'mina.suggest.private' },
  { id: 'spaceDesign', kind: 'bubble', expr: 'laugh', titleKey: 'mina.spaceDesign.t', bodyKey: 'mina.spaceDesign.b', anchor: ['space-edit-$s1'], info: true },
  { id: 'acctManual', kind: 'fullscreen', art: 'acctManual', titleKey: 'mina.acctManual.t', bodyKey: 'mina.acctManual.b' },
  { id: 'acctImport', kind: 'fullscreen', art: 'acctImport', titleKey: 'mina.acctImport.t', bodyKey: 'mina.acctImport.b' },
  { id: 'acctLinked', kind: 'fullscreen', art: 'acctLinked', titleKey: 'mina.acctLinked.t', bodyKey: 'mina.acctLinked.b' },
  { id: 'goSettings', kind: 'bubble', expr: 'sad', titleKey: 'mina.makeAccount.t', bodyKey: 'mina.goSettings.b', anchor: ['tab-settings', 'side-tab-settings'], gate: true },
  { id: 'openSpaceCard', kind: 'bubble', expr: 'sad', titleKey: 'mina.makeAccount.t', bodyKey: 'mina.openSpaceCard.b', anchor: ['settings-space-accounts-row'], gate: true },
  { id: 'openAdd', kind: 'bubble', expr: 'sad', titleKey: 'mina.makeAccount.t', bodyKey: 'mina.openAdd.b', anchor: ['space-accounts-add'], gate: true },
  { id: 'pickManual', kind: 'bubble', expr: 'sad', titleKey: 'mina.makeAccount.t', bodyKey: 'mina.pickManual.b', anchor: ['chooser-manual'], gate: true },
  { id: 'pickChecking', kind: 'bubble', expr: 'sad', titleKey: 'mina.makeAccount.t', bodyKey: 'mina.pickChecking.b', anchor: ['chooser-accttype-checking'], gate: true },
  { id: 'createAccount', kind: 'bubble', expr: 'thinking', titleKey: 'mina.makeAccount.t', bodyKey: 'mina.createAccount.b', act: { entity: 'account' }, suggestKey: 'mina.suggest.wallet' },
  { id: 'txConcept', kind: 'fullscreen', art: 'txAccount', titleKey: 'mina.txConcept.t', bodyKey: 'mina.txConcept.b' },
  { id: 'goTransactions', kind: 'bubble', expr: 'smile', titleKey: 'mina.firstTx.t', bodyKey: 'mina.goTransactions.b', anchor: ['tab-transactions', 'side-tab-transactions'], gate: true },
  { id: 'openTxAdd', kind: 'bubble', expr: 'smile', titleKey: 'mina.firstTx.t', bodyKey: 'mina.openTxAdd.b', anchor: ['tx-add'], gate: true },
  { id: 'createTx', kind: 'bubble', expr: 'thinking', titleKey: 'mina.firstTx.t', bodyKey: 'mina.createTx.b', act: { entity: 'transaction' }, suggestKey: 'mina.suggest.groceries' },
  { id: 'goHomePayoff', kind: 'bubble', expr: 'smile', titleKey: 'mina.payoff.t', bodyKey: 'mina.goHomePayoff.b', anchor: ['tab-home', 'side-tab-home'], gate: true },
  { id: 'payoff', kind: 'bubble', expr: 'smile', titleKey: 'mina.payoff.t', bodyKey: 'mina.payoff.b', anchor: ['home-overview'], info: true },
  { id: 'openSwitcher2', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.family.t', bodyKey: 'mina.openSwitcher.b', anchor: ['home-space-switcher'], gate: true },
  { id: 'openManage2', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.family.t', bodyKey: 'mina.openManage.b', anchor: ['space-pick-manage'], gate: true },
  { id: 'openCreate2', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.family.t', bodyKey: 'mina.openCreate.b', anchor: ['spaces-add'], gate: true },
  { id: 'createFamily', kind: 'bubble', expr: 'thinking', titleKey: 'mina.family.t', bodyKey: 'mina.createFamily.b', act: { entity: 'space' }, suggestKey: 'mina.suggest.family' },
  { id: 'switchFamily', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.family.t', bodyKey: 'mina.switchFamily.b', anchor: ['space-row-$s2'], gate: true },
  { id: 'goTransactions2', kind: 'bubble', expr: 'thinking', titleKey: 'mina.isolation.t', bodyKey: 'mina.goTransactions2.b', anchor: ['tab-transactions', 'side-tab-transactions'], gate: true },
  { id: 'emptyList', kind: 'bubble', expr: 'thinking', titleKey: 'mina.isolation.t', bodyKey: 'mina.emptyList.b' },
  { id: 'tryTxAdd', kind: 'bubble', expr: 'thinking', titleKey: 'mina.isolation.t', bodyKey: 'mina.tryTxAdd.b', anchor: ['tx-add'], gate: true },
  { id: 'noAccounts', kind: 'bubble', expr: 'thinking', titleKey: 'mina.isolation.t', bodyKey: 'mina.noAccounts.b', anchor: ['txform-no-accounts'], info: true },
  { id: 'goSettings2', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.cleanup.t', bodyKey: 'mina.goSettings2.b', anchor: ['tab-settings', 'side-tab-settings'], gate: true },
  { id: 'openSpaceSettings', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.cleanup.t', bodyKey: 'mina.openSpaceSettings.b', anchor: ['settings-space-row'], gate: true },
  { id: 'deleteFamily', kind: 'bubble', expr: 'armcrossed', titleKey: 'mina.cleanup.t', bodyKey: 'mina.deleteFamily.b', anchor: ['space-edit-delete'], act: { entity: 'space', absent: true } },
  { id: 'wrap', kind: 'fullscreen', art: 'handopen', titleKey: 'mina.wrap.t', bodyKey: 'mina.wrap.b' },
];

export const minaStepIndex = (id: string): number => MINA_STEPS.findIndex((s) => s.id === id);

// ── run state (persisted in meta so a killed app resumes) ────────────────
export interface MinaLedgerEntry {
  entity: MinaEntity;
  spaceId: string;
  id: string;
}
export interface MinaRunState {
  active: boolean;
  step: number;
  /** everything created THIS run — the wrap/skip revert offer */
  ledger: MinaLedgerEntry[];
}
export const MINA_STATE_KEY = 'minaTutorialState';
export const MINA_DONE_KEY = 'minaTutorialDone';

// ── live form suggestions (module-level: forms read, controller writes) ──
// The tutorial never writes DATA; pre-filling a form the user still
// submits is presentation. Cleared the moment the step advances.
let suggestions: { spaceName?: string; accountName?: string; txMerchant?: string; txAmount?: string } = {};
export const setMinaSuggestions = (next: typeof suggestions): void => {
  suggestions = next;
};
export const minaSuggestedSpaceName = (): string | undefined => suggestions.spaceName;
export const minaSuggestedAccountName = (): string | undefined => suggestions.accountName;
export const minaSuggestedTx = (): { merchant: string; amount: string } | undefined =>
  suggestions.txMerchant ? { merchant: suggestions.txMerchant, amount: suggestions.txAmount ?? '' } : undefined;
