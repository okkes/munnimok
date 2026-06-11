export const T = {
  // Auth — login screen
  loginEmailBtn:        'login-email-btn',
  loginGoogleBtn:       'login-google-btn',
  loginAppleBtn:        'login-apple-btn',
  loginDemoBtn:         'login-demo-btn',
  loginEmailInput:      'login-email-input',
  loginEmailSubmit:     'login-email-submit',
  loginCreateAccount:   'login-create-account',
  loginError:           'login-error',
  loginSsoLoading:      'login-sso-loading',
  loginNoAccount:       'login-no-account',
  loginTermsLink:       'login-terms-link',
  loginPrivacyLink:     'login-privacy-link',
  loginLangBtn:         'login-lang-btn',
  termsScreen:          'terms-screen',

  // Auth — signup flow
  signupPickEmail:      'signup-pick-email',
  signupPickGoogle:     'signup-pick-google',
  signupPickApple:      'signup-pick-apple',
  signupSendCode:       'signup-send-code',
  signupEmailError:     'signup-email-error',
  signupSignInInstead:  'signup-sign-in-instead',

  // Auth — email-input screen
  emailInputContinue:   'email-input-continue',

  // Auth — verify screen
  verifyAutoFilling:    'verify-autofilling',

  // Auth — onboarding step 1
  onboardStep1:         'onboard-step1',
  onboardFirstName:     'onboard-firstname',
  onboardLastName:      'onboard-lastname',
  onboardFirstNameErr:  'onboard-firstname-error',
  onboardLastNameErr:   'onboard-lastname-error',
  onboardContinue:      'onboard-continue',
  onboardAvatarBtn:     'onboard-avatar-btn',
  onboardAvatarPicker:  'onboard-avatar-picker',
  onboardApiInfoBtn:    'onboard-api-info-btn',
  onboardApiInfoSheet:  'onboard-api-info-sheet',
  onboardCountryBtn:    'onboard-country-btn',
  onboardCountrySheet:  'onboard-country-sheet',
  onboardCountryErr:    'onboard-country-error',

  // Auth — onboarding step 2
  onboardStep2:         'onboard-step2',
  onboardAddBank:       'onboard-add-bank',
  onboardAddAnotherBank:'onboard-add-another-bank',
  onboardBankSkip:      'onboard-bank-skip',
  onboardComplete:      'onboard-complete',
  onboardBankRow:       'onboard-bank-row',

  // Auth — bank search sub-screen
  bankSearchScreen:     'bank-search-screen',
  bankSearchInput:      'bank-search-input',
  bankSearchNoResults:  'bank-search-no-results',
  bankListRow:          'bank-list-row',

  // Auth — bank credentials sub-screen
  bankCredsScreen:      'bank-creds-screen',
  bankCredsUsername:    'bank-creds-username',
  bankCredsConnect:     'bank-creds-connect',
  bankCredsError:       'bank-creds-error',

  // Auth — PSD2 consent
  bankConsentScreen:    'bank-consent-screen',
  bankConsentAuthorise: 'bank-consent-authorise',

  // Auth — bank connecting
  bankConnectingScreen: 'bank-connecting-screen',

  // Auth — bank done
  bankDoneScreen:       'bank-done-screen',
  bankDoneBtn:          'bank-done-btn',

  // Nav / TabBar (ids match `tab-${tab.id}` from TabBar component)
  tabHome:              'tab-home',
  tabTransactions:      'tab-tx',
  tabRecurring:         'tab-recurring',
  tabEvents:            'tab-events',
  tabInsights:          'tab-insights',
  tabProfile:           'tab-profile',

  // Home
  homeCard:             'home-card',
  homeAddTx:            'home-add-tx',
  homeBalanceTile:      'home-balance-tile',

  // Transactions
  txRow:                'tx-row',
  txSearchInput:        'tx-search-input',
  txFilterBtn:          'tx-filter-btn',
  txAddBtn:             'tx-add-btn',
  txDetailSheet:        'tx-detail-sheet',

  // Events
  eventRow:             'event-row',
  eventAddBtn:          'event-add-btn',
  eventDetailSheet:     'event-detail-sheet',

  // Profile
  profileCountryBtn:    'profile-country-btn',
  profileCountrySheet:  'profile-country-sheet',
  profileCountrySearch: 'profile-country-search',
  profileCountryErr:    'profile-country-error',
  profileAvatarBtn:     'profile-avatar-btn',
  profileNameInput:     'profile-name-input',
  profileSaveBtn:       'profile-save-btn',
  profileNewBtn:        'profile-new-btn',
  profileSwitchRow:     'profile-switch-row',
  profileSettingsBtn:   'profile-settings-btn',
  profileLogoutBtn:     'profile-logout-btn',

  // Members
  memberRow:            'member-row',
  memberAddBtn:         'member-add-btn',
  memberActionSheet:    'member-action-sheet',
  memberPermPill:       (perm) => `member-perm-${perm}`,
  memberKickBtn:        'member-kick-btn',

  // Settings
  settingRow:           'setting-row',
  settingLangPicker:    'setting-lang-picker',
  langOption:           'lang-option',
  darkModeToggle:       'dark-mode-toggle',

  // Accounts
  accountRow:           'account-row',
  accountAddBtn:        'account-add-btn',
  accountAttachToggle:  'account-attach-toggle',
  savingsRow:           'savings-row',
  savingsAddBtn:        'savings-add-btn',

  // Recurring
  recurringRow:         'recurring-row',
  recurringAddBtn:      'recurring-add-btn',
  recurringDetailSheet: 'recurring-detail-sheet',

  // Budgets
  budgetRow:            'budget-row',
  budgetAddBtn:         'budget-add-btn',

  // Goals
  goalRow:              'goal-row',
  goalAddBtn:           'goal-add-btn',

  // Offline mode — login/select/create
  loginOfflineBtn:      'login-offline-btn',
  offlineInfoScreen:    'offline-info-screen',
  offlineInfoCta:       'offline-info-cta',
  offlineInfoBack:      'offline-info-back',
  offlineSelectScreen:  'offline-select-screen',
  offlineAddProfile:    'offline-add-profile',
  offlineCreateScreen:  'offline-create-screen',
  offlineCreateName:    'offline-create-name',
  offlineCreateCta:     'offline-create-cta',
  offlineCreateRecoverBtn: 'offline-create-recover-btn',
  offlineHomeBanner:    'offline-home-banner',

  // Offline mode — recover flow (App.jsx, pre-login)
  offlineRecoverScreen:     'offline-recover-screen',
  offlineRecoverFilePick:   'offline-recover-file-pick',
  offlineRecoverKeyInput:   'offline-recover-key-input',
  offlineRecoverStart:      'offline-recover-start',
  offlineRecoverSuccess:    'offline-recover-success',

  // Offline profile — key management & backup (Profile.jsx)
  offlineProfileKeySection:    'offline-profile-key-section',
  offlineProfileKeyToggle:     'offline-profile-key-toggle',
  offlineProfileKeyRegen:      'offline-profile-key-regen',
  offlineProfileKeyInfoBtn:    'offline-profile-key-info-btn',
  offlineProfileKeyInfoSheet:  'offline-profile-key-info-sheet',
  offlineProfileRegenSheet:    'offline-profile-regen-sheet',
  offlineProfileRegenConfirm:  'offline-profile-regen-confirm',
  offlineProfileBackupBtn:     'offline-profile-backup-btn',
  offlineProfileBackupSheet:   'offline-profile-backup-sheet',
  offlineProfileBackupConfirm: 'offline-profile-backup-confirm',
  offlineProfileRecoverBtn:    'offline-profile-recover-btn',
  offlineProfileRecoverSheet:  'offline-profile-recover-sheet',
  offlineProfileRecoverFilePick: 'offline-profile-recover-file-pick',
  offlineProfileRecoverKeyInput: 'offline-profile-recover-key-input',
  offlineProfileRecoverStart:    'offline-profile-recover-start',
  offlineProfileRecoverSuccess:  'offline-profile-recover-success',
  offlineProfileAutoBackupBtn:   'offline-profile-auto-backup-btn',
  offlineProfileAutoBackupSheet: 'offline-profile-auto-backup-sheet',
  offlineProfileAutoBackupSave:  'offline-profile-auto-backup-save',

  // Shared
  sheetClose:           'sheet-close',
  confirmBtn:           'confirm-btn',
  cancelBtn:            'cancel-btn',
  backBtn:              'back-btn',
};
