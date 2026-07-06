export const FEATURE       = 'userinfo';
export const FEATURE_LABEL = 'User Info & Settings (Profile)';

export const GROUPS = [
  {
    name: 'Country Field',
    tests: [
      {
        key: '01-userinfo-country-picker',
        title: 'Country picker — open and select',
        desc: 'Tap the Country field on My Profile → country Sheet opens. Tap "Germany" → sheet closes, Germany appears in the country button.',
        tags: ['ui', 'state'],
        steps: [
          'Email signup → My Profile',
          'Country field tapped',
          'Country sheet open — Germany tapped',
          'Germany shown in country button',
        ],
      },
      {
        key: '02-userinfo-country-search',
        title: 'Country picker — search and persist',
        desc: 'Open country picker, type "Ger" → filtered list with "Ger" highlighted; select Germany. Save → go back to My Profile → Germany still shown.',
        tags: ['state', 'search'],
        steps: [
          'Country sheet open — "Ger" typed, filtered list',
          'Germany selected, country button updated',
          'Save pressed → back to My Profile → Germany retained',
        ],
      },
    ],
  },
  {
    name: 'Settings Screen (ScreenProfile)',
    tests: [
      {
        key: '03-settings-layout-email',
        title: 'Settings — email user layout',
        desc: 'Email user on the Settings tab: identity card shows full name, email and avatar. Sign-out row visible. No "Demo" badge.',
        tags: ['ui', 'layout'],
        steps: [
          'Email signup → Settings tab',
          'Identity card with name and email — no Demo badge',
          'Sign-out row visible',
        ],
      },
      {
        key: '04-settings-layout-demo',
        title: 'Settings — demo user layout',
        desc: 'Demo user: identity card shows "Demo" badge + demo@munni.app email. Reset demo row visible.',
        tags: ['ui', 'layout', 'demo'],
        steps: [
          'Demo login → Settings tab',
          'Identity card with Demo badge and demo email',
          'Reset demo row visible',
        ],
      },
      {
        key: '05-settings-signout',
        title: 'Settings — sign out returns to login',
        desc: 'Tap Sign out → app lands on the Login screen. Session storage cleared.',
        tags: ['navigation'],
        steps: [
          'Settings tab — Sign out tapped',
          'Login screen shown',
        ],
      },
      {
        key: '06-settings-reset-sheet',
        title: 'Settings — reset demo sheet + cancel',
        desc: 'Demo user: tap "Reset demo data" → bottom sheet slides up. Tap Cancel → sheet dismisses without resetting.',
        tags: ['state', 'demo'],
        steps: [
          'Demo — Reset demo row tapped',
          'Reset confirmation sheet open',
          'Cancel tapped — sheet dismissed',
        ],
      },
    ],
  },
  {
    name: 'My Profile Layout Variants',
    tests: [
      {
        key: '07-userinfo-layout-demo',
        title: 'My Profile — demo user',
        desc: 'Demo user: name inputs exist but are disabled. No Save button. No API endpoint section. No Delete account row. "Demo account" label visible.',
        tags: ['ui', 'layout', 'demo'],
        steps: [
          'Demo login → My Profile',
          'Name fields disabled — no Save/API/Delete',
          '"Demo account" label shown',
        ],
      },
      {
        key: '08-userinfo-layout-google',
        title: 'My Profile — Google SSO user',
        desc: 'Google user: name inputs enabled. Save button present. API endpoint row visible. Email row NOT tappable (no m-tap, lock icon). "Signed in with Google" subtitle shown.',
        tags: ['ui', 'layout'],
        steps: [
          'Google signup → My Profile',
          'Name fields editable — Save + API rows present',
          'Email row locked (no m-tap)',
          '"Signed in with Google" shown',
        ],
      },
      {
        key: '09-userinfo-layout-email',
        title: 'My Profile — email user',
        desc: 'Email user: all fields editable. Email row has m-tap class (tappable). API endpoint and Delete account rows both visible.',
        tags: ['ui', 'layout'],
        steps: [
          'Email signup → My Profile',
          'Name fields editable, email row tappable',
          'API + Delete rows visible',
        ],
      },
    ],
  },
  {
    name: 'Photo Picker',
    tests: [
      {
        key: '10-photo-picker-opens',
        title: 'Photo picker — opens with avatar grid',
        desc: 'Tap "Change photo" → bottom Sheet slides up with a grid of stock avatar buttons.',
        tags: ['state', 'ui'],
        steps: [
          'My Profile — "Change photo" tapped',
          'Pic sheet open with stock avatar grid',
        ],
      },
      {
        key: '11-photo-picker-select',
        title: 'Photo picker — select avatar updates header',
        desc: 'Tap a stock avatar → sheet closes, avatar button in header now shows the selected emoji instead of initials.',
        tags: ['state'],
        steps: [
          'Pic sheet open — first avatar tapped',
          'Sheet closed — header avatar updated with emoji',
        ],
      },
      {
        key: '12-photo-picker-remove',
        title: 'Photo picker — remove photo restores initials',
        desc: 'After setting a custom avatar: re-open picker → "Remove photo" button visible. Tap it → sheet closes, avatar reverts to initials gradient.',
        tags: ['state', 'edge-case'],
        steps: [
          'Avatar set → re-open picker',
          '"Remove photo" button visible — tapped',
          'Avatar back to initials gradient',
        ],
      },
    ],
  },
  {
    name: 'Country Info Sheet',
    tests: [
      {
        key: '13-country-info-sheet',
        title: 'Country info sheet opens',
        desc: 'Tap the ⓘ icon next to the COUNTRY label → info sheet slides up explaining what the country field is used for.',
        tags: ['state', 'ui'],
        steps: [
          'My Profile — ⓘ next to COUNTRY tapped',
          'Country info sheet open with explanation text',
        ],
      },
    ],
  },
  {
    name: 'Name Editing',
    tests: [
      {
        key: '14-name-edit-save',
        title: 'Name edit — save persists to Settings card',
        desc: 'Clear and retype first + last name, tap Save → app navigates back to Settings. Identity card shows updated full name.',
        tags: ['state', 'navigation'],
        steps: [
          'My Profile — name fields cleared and filled with "Alice Wonder"',
          'Save tapped → Settings tab',
          'Identity card shows "Alice Wonder"',
        ],
      },
      {
        key: '15-name-reflects-signup',
        title: 'Name edit — signup data pre-fills profile',
        desc: 'Name and country entered during onboarding step 1 appear verbatim in My Profile first/last name inputs and country button.',
        tags: ['state', 'data-propagation'],
        steps: [
          'Signup with "Jane Doe" + Germany',
          'My Profile — first name "Jane", last name "Doe", country "Germany"',
        ],
      },
    ],
  },
  {
    name: 'API Endpoint',
    tests: [
      {
        key: '16-api-sheet-open',
        title: 'API sheet — opens with Reset and Save CTAs',
        desc: 'Tap the API endpoint row → Sheet opens with a URL input, Reset and Save buttons.',
        tags: ['state', 'ui'],
        steps: [
          'My Profile — API row tapped',
          'API sheet open — URL input + Reset + Save',
        ],
      },
      {
        key: '17-api-sheet-save',
        title: 'API sheet — save stores custom URL',
        desc: 'Enter a custom URL, tap Save → sheet closes. API row now displays the custom hostname.',
        tags: ['state'],
        steps: [
          'API sheet — custom URL typed',
          'Save tapped — sheet closed',
          'API row shows custom hostname',
        ],
      },
      {
        key: '18-api-sheet-reset',
        title: 'API sheet — reset restores default',
        desc: 'After saving a custom URL, re-open API sheet and tap Reset → sheet closes. API row no longer shows the custom hostname.',
        tags: ['state', 'edge-case'],
        steps: [
          'Custom URL saved → re-open API sheet',
          'Reset tapped — sheet closed',
          'API row back to default URL',
        ],
      },
    ],
  },
  {
    name: 'Change Email',
    tests: [
      {
        key: '19-change-email-opens',
        title: 'Change email — sheet opens (email user)',
        desc: 'Email user taps the email row → Sheet opens with a new-email input (step 1 of 2).',
        tags: ['state', 'ui'],
        steps: [
          'My Profile — email row tapped',
          'Change email sheet open — new email input',
        ],
      },
      {
        key: '20-change-email-invalid',
        title: 'Change email — invalid format shows error',
        desc: 'Enter "notanemail" and tap Continue → inline error "Invalid email" shown; does not advance to step 2.',
        tags: ['validation', 'error'],
        steps: [
          'Change email — "notanemail" typed',
          'Continue tapped — invalid email error shown',
        ],
      },
      {
        key: '21-change-email-verify',
        title: 'Change email — verify step + wrong code error',
        desc: 'Enter a valid new address, advance to OTP step. Enter "000000" and tap Confirm → wrong-code error shown.',
        tags: ['validation', 'error'],
        steps: [
          'Valid new email → advance to OTP step',
          '"000000" entered — Confirm pressed',
          'Invalid code error shown',
        ],
      },
      {
        key: '22-change-email-done',
        title: 'Change email — correct code updates email row',
        desc: 'Enter the correct OTP (123456 in demo mode), tap Confirm → done state shows checkmark + new email. Tap Done → sheet closes. Email row now shows the new address.',
        tags: ['state'],
        steps: [
          'OTP step — "123456" entered',
          'Done state — checkmark + new email shown',
          'Done tapped — sheet closed',
          'Email row updated to new address',
        ],
      },
    ],
  },
  {
    name: 'Delete Account',
    tests: [
      {
        key: '23-delete-opens',
        title: 'Delete account — sheet opens with reasons',
        desc: 'Tap "Delete account" row → Sheet opens with feedback checkboxes (at least 4 reasons).',
        tags: ['state', 'ui'],
        steps: [
          'My Profile — Delete account row tapped',
          'Delete sheet open — reason checkboxes visible',
        ],
      },
      {
        key: '24-delete-reasons',
        title: 'Delete account — ticking reason fills checkbox',
        desc: 'Tap a reason row → the checkbox visual changes to filled (sage background).',
        tags: ['state', 'ui'],
        steps: [
          'Delete sheet — first reason tapped',
          'Checkbox filled (sage background)',
        ],
      },
      {
        key: '25-delete-confirm',
        title: 'Delete account — confirm step shows red CTA + Back',
        desc: 'Tap Continue on the reasons step → confirm step shows red "Delete account" CTA and a "Back" button. Tap Back → returns to reasons step.',
        tags: ['state', 'navigation'],
        steps: [
          'Delete sheet — Continue tapped',
          'Confirm step — red Delete + Back CTAs',
          'Back tapped — reasons step restored',
        ],
      },
      {
        key: '26-delete-executes',
        title: 'Delete account — confirm executes: lands on login',
        desc: 'On the confirm step, tap "Delete account" → account deleted, app navigates to the Login screen.',
        tags: ['navigation'],
        steps: [
          'Delete confirm step — "Delete account" tapped',
          'Login screen shown',
        ],
      },
    ],
  },
  {
    name: 'Signup Data Propagation',
    tests: [
      {
        key: '27-onboarding-data',
        title: 'Onboarding data appears in My Profile',
        desc: 'First name, last name and country entered during signup step 1 are pre-filled verbatim in My Profile. Tests the data pipeline: onboarding → localStorage → profile component.',
        tags: ['data-propagation', 'first-run'],
        steps: [
          'Signup with "Sophie Martin" + France',
          'My Profile — first name "Sophie", last name "Martin", country "France"',
        ],
      },
    ],
  },
];
