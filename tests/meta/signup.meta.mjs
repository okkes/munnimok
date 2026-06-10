export const FEATURE       = 'signup';
export const FEATURE_LABEL = 'Signup & Onboarding';

export const GROUPS = [
  {
    name: 'Login Screen Extras',
    tests: [
      {
        key: '20-lang-picker-open',
        title: 'Language picker opens',
        desc: 'Tap "🌐 Change language" → full-screen language picker. Three supported languages (EN, NL, TR) each show native name, English name, and "Available" badge.',
        tags: ['navigation'],
        steps: [
          'Login screen — "Change language" tapped',
          'Language picker — all 3 supported languages visible',
        ],
      },
      {
        key: '21-lang-switch-nl',
        title: 'Switch language to Dutch',
        desc: 'Select "Nederlands" in the picker → returns to login screen. Heading changes from "Welcome" to "Welkom", subtitle and all UI text update to Dutch.',
        tags: ['navigation', 'state'],
        steps: [
          'Login screen (English)',
          'Language picker',
          'Login screen — heading now "Welkom" after Dutch selected',
        ],
      },
      {
        key: '22-terms-screen',
        title: 'Terms of Service screen',
        desc: 'Tap the "Terms of Service" link → ScreenTerms renders with 7 numbered sections (Acceptance, Service description, Read-only access, etc.). Back button returns to login.',
        tags: ['navigation'],
        steps: [
          'Login screen — "Terms of Service" link tapped',
          'Terms of Service screen',
        ],
      },
      {
        key: '23-privacy-screen',
        title: 'Privacy Policy screen',
        desc: 'Tap the "Privacy Policy" link → same ScreenTerms component with privacy content: Data we collect, How we use your data, Data storage, Your rights, Cookies, Contact.',
        tags: ['navigation'],
        steps: [
          'Login screen — "Privacy Policy" link tapped',
          'Privacy Policy screen',
        ],
      },
      {
        key: '24-demo-user',
        title: 'Continue as demo user',
        desc: 'Tap "Continue as demo user" at the very bottom → bypasses all auth. App loads instantly as "Demo van der Berg" with pre-seeded bank accounts and transactions.',
        tags: ['state'],
        steps: [
          'Login screen — "Continue as demo user" tapped',
          'Home screen — loaded as demo user',
        ],
      },
    ],
  },
  {
    name: 'Onboarding — Step 1 (Profile)',
    tests: [
      {
        key: '25-onboard-step1-fresh',
        title: 'Step 1 — profile form (fresh)',
        desc: 'After email verification, step 1 shows: avatar placeholder (initials when first name is typed), first/last name inputs, read-only email row, optional API URL field, and Continue CTA.',
        tags: ['first-run'],
        steps: [
          'Login screen',
          'Signup method picker',
          'Email form — new address filled',
          'Verification — code auto-filling',
          'Step 1 — profile form',
        ],
      },
      {
        key: '26-onboard-firstname-error',
        title: 'Step 1 — first name missing',
        desc: 'Submit step 1 with empty first name. Input border turns red, error message "First name is required" appears below the field. Last name field is unaffected.',
        tags: ['validation', 'error'],
        steps: [
          'Step 1 — form empty, Continue pressed',
          'First name required error shown',
        ],
      },
      {
        key: '27-onboard-lastname-error',
        title: 'Step 1 — last name missing',
        desc: 'First name filled, last name left empty. Only the last name field shows the error border and "Last name is required" message.',
        tags: ['validation', 'error'],
        steps: [
          'Step 1 — first name filled, last name empty',
          'Last name required error shown',
        ],
      },
      {
        key: '28-onboard-name-toolong',
        title: 'Step 1 — name exceeds 50 chars',
        desc: 'Either name field filled with 51+ characters → "Name is too long" error. The 50-char limit applies to first and last name independently.',
        tags: ['validation', 'error', 'edge-case'],
        steps: [
          'Step 1 — 51-character first name typed',
          'Name too long error',
        ],
      },
      {
        key: '29-onboard-api-info',
        title: 'Step 1 — API URL info tooltip',
        desc: 'Tap the ⓘ next to "API URL" → bottom sheet overlay slides up explaining what the backend URL is used for. Tap outside or anywhere on overlay to dismiss.',
        tags: ['state'],
        steps: [
          'Step 1 — API URL info icon tapped',
          'API info overlay open',
        ],
      },
      {
        key: '30-onboard-avatar-picker',
        title: 'Step 1 — avatar picker & selection',
        desc: 'Tap the avatar circle → bottom sheet shows "Choose from library" file picker + 5×N grid of emoji stock avatars. Selecting an avatar updates the header avatar immediately.',
        tags: ['state'],
        steps: [
          'Step 1 — avatar tapped',
          'Avatar picker sheet open (stock avatars grid)',
          'Step 1 — avatar updated with selected emoji',
        ],
      },
      {
        key: '31-onboard-sso-google',
        title: 'Step 1 — Google SSO variant',
        desc: 'When signup is via Google: avatar shows the Google logo, email row is pre-filled with "munni-demo@gmail.com" and locked (🔒 icon, not editable). Name fields are empty for the user to fill.',
        tags: ['state'],
        steps: [
          'Signup picker — Google tapped',
          'SSO loading screen (1400 ms)',
          'Step 1 — email pre-filled with Google icon, field locked',
        ],
      },
      {
        key: '32-onboard-step1-to-step2',
        title: 'Step 1 → Step 2 transition',
        desc: 'Fill first and last name, tap Continue → step 2 (bank connect) slides in. Step 1 is validated before advancing.',
        tags: ['navigation'],
        steps: [
          'Step 1 — name filled, Continue tapped',
          'Step 2 — bank connect screen',
        ],
      },
    ],
  },
  {
    name: 'Onboarding — Step 2 (Bank Connect)',
    tests: [
      {
        key: '33-onboard-step2-empty',
        title: 'Step 2 — empty state',
        desc: 'No bank connected yet. "Add bank" is the primary full-width sage CTA. "Skip for now" link below. PSD2 read-only footnote (🔒) at the bottom.',
        tags: ['first-run'],
        steps: [
          'Step 1 — filled',
          'Step 2 — empty: Add bank CTA, Skip link, PSD2 footnote',
        ],
      },
      {
        key: '34-bank-search-filter',
        title: 'Bank search — filter results',
        desc: 'Tap "Add bank" → bank search screen. Type "rabo" → list filters to only show Rabobank with the matching substring highlighted. BIC is also searched.',
        tags: ['state'],
        steps: [
          'Step 2 — "Add bank" tapped',
          'Bank search — "rabo" typed, list filtered',
        ],
      },
      {
        key: '35-bank-search-no-results',
        title: 'Bank search — no results',
        desc: 'Search query "zzz" matches no bank name or BIC. Empty state: "No results" message in the list area.',
        tags: ['edge-case'],
        steps: [
          'Bank search open',
          '"zzz" typed — no results empty state',
        ],
      },
      {
        key: '36-bank-creds-form',
        title: 'Bank credentials form',
        desc: 'Select ING from the list → credentials screen. Bank logo + BIC shown at top, PSD2 note, then pre-filled username/password/IBAN form. "Connect" CTA at the bottom.',
        tags: ['state'],
        steps: [
          'Bank search — ING selected',
          'Bank credentials form — username, password, IBAN pre-filled',
        ],
      },
      {
        key: '37-bank-creds-error',
        title: 'Bank credentials — empty username',
        desc: 'Clear the username field and tap "Connect" → inline error "Login name is required". Username input border turns red.',
        tags: ['validation', 'error'],
        steps: [
          'Bank credentials — username cleared',
          'Error: login name is required',
        ],
      },
      {
        key: '47-bank-creds-password-error',
        title: 'Bank credentials — empty password',
        desc: 'Username filled, password cleared, tap "Connect" → inline error "Enter your password". Password input border turns red; username border remains normal.',
        tags: ['validation', 'error'],
        steps: [
          'Bank credentials — username filled, password cleared',
          'Error: password is required',
        ],
      },
      {
        key: '38-bank-psd2-consent',
        title: 'PSD2 consent screen',
        desc: '"Connect" pressed with valid credentials → PSD2 consent screen. Shows two permission rows: (1) Account info (read-only) and (2) Transaction history. "Authorise" and "Cancel" CTAs.',
        tags: ['state'],
        steps: [
          'Bank credentials — Connect pressed',
          'PSD2 consent — 2 read-only permission rows',
        ],
      },
      {
        key: '39-bank-connecting',
        title: 'Bank connecting spinner',
        desc: '"Authorise" tapped → connecting state with bank logo and 3 pulsing dots. This state lasts 1800 ms while the simulated PSD2 handshake runs.',
        tags: ['state', 'animation'],
        steps: [
          'PSD2 consent — Authorise tapped',
          'Connecting — bank logo + pulsing dots',
        ],
      },
      {
        key: '40-bank-connected',
        title: 'Bank connected — success',
        desc: 'After the 1800 ms connecting delay, success screen appears: large green check icon, "Connected!" heading, subtitle confirms the bank name. "Done" CTA returns to step 2.',
        tags: ['state'],
        steps: [
          'Connecting state (1800 ms)',
          'Connected — green check icon, "Done" CTA',
        ],
      },
      {
        key: '41-step2-with-bank',
        title: 'Step 2 — bank row + Complete CTA',
        desc: 'After completing the PSD2 flow, step 2 shows the connected bank row (logo, name, IBAN) with an × to remove, a dashed "Add another bank" button, and the "Complete" primary CTA.',
        tags: ['state'],
        steps: [
          'Bank done — "Done" pressed',
          'Step 2 — bank row, Add another, Complete CTA',
        ],
      },
      {
        key: '42-step2-skip',
        title: 'Step 2 — skip, home loads',
        desc: '"Skip for now" on step 2 completes onboarding without a bank account. App transitions to the home screen.',
        tags: ['navigation'],
        steps: [
          'Step 2 — "Skip for now" tapped',
          'Home screen loaded',
        ],
      },
      {
        key: '43-bank-remove',
        title: 'Step 2 — remove connected bank',
        desc: 'Tap the × on a connected bank row → row disappears, step 2 returns to the empty "Add bank" CTA state.',
        tags: ['state', 'edge-case'],
        steps: [
          'Step 2 — bank row connected',
          'Bank row removed (× pressed)',
          'Step 2 — empty state restored',
        ],
      },
    ],
  },
  {
    name: 'Onboarding — Browser Back Navigation',
    tests: [
      {
        key: '44-back-step2-to-step1',
        title: 'Back: step 2 → step 1',
        desc: 'Browser back from step 2 (no bank connected) returns to step 1 with previously entered name still intact.',
        tags: ['navigation'],
        steps: [
          'Step 2 — empty (back pressed)',
          'Step 1 — name preserved',
        ],
      },
      {
        key: '45-back-search-to-step2',
        title: 'Back: bank search → step 2',
        desc: 'Browser back from the bank search screen returns to step 2.',
        tags: ['navigation'],
        steps: [
          'Bank search open (back pressed)',
          'Step 2 — returned',
        ],
      },
      {
        key: '46-back-creds-to-search',
        title: 'Back: bank credentials → search',
        desc: 'Browser back from the credentials form returns to the bank search list, not to step 2.',
        tags: ['navigation'],
        steps: [
          'Bank credentials open (back pressed)',
          'Bank search — returned',
        ],
      },
    ],
  },
];
