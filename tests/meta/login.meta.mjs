export const FEATURE       = 'login';
export const FEATURE_LABEL = 'Login';

export const GROUPS = [
  {
    name: 'Main Login',
    tests: [
      {
        key: '01-login-fresh',
        title: 'Fresh install',
        desc: 'First-time user — munni_opened_before not set → heading reads "Welcome to munni". All three sign-in methods visible.',
        tags: ['first-run'],
      },
      {
        key: '02-login-returning',
        title: 'Returning user',
        desc: 'munni_opened_before = "true" → heading changes to "Welcome back". Email field may be pre-filled from sessionStorage.',
        tags: ['returning'],
      },
      {
        key: '03-login-email-error',
        title: 'Email not found',
        desc: 'Unregistered address entered → red border, error text, inline "Create account →" CTA.',
        tags: ['error', 'edge-case'],
        steps: [
          'Login screen — email address typed',
          'Error: no account found for this address',
        ],
      },
      {
        key: '04-login-sso-loading',
        title: 'Google SSO — loading',
        desc: 'Full-screen state shown for 1400 ms while the app simulates the SSO handshake. Three pulsing dots animate below the provider logo.',
        tags: ['state', 'animation'],
        steps: [
          'Login screen — Google button tapped',
          'SSO handshake in progress (1400 ms)',
        ],
      },
      {
        key: '05-login-sso-loading-apple',
        title: 'Apple SSO — loading',
        desc: 'Same loading screen for Apple. Provider logo and dot color differ from Google.',
        tags: ['state', 'animation'],
        steps: [
          'Login screen — Apple button tapped',
          'SSO handshake in progress (1400 ms)',
        ],
      },
    ],
  },
  {
    name: 'Signup — Method Picker',
    tests: [
      {
        key: '06-signup-picker',
        title: 'Method picker (all available)',
        desc: 'No prior accounts. All three options available: Google, Apple, and email.',
        tags: ['first-run'],
        steps: [
          'Login screen — "Create account" tapped',
          'Signup picker — Google, Apple, and email all enabled',
        ],
      },
      {
        key: '07-signup-google-disabled',
        title: 'Google already registered',
        desc: 'munni_signup_methods includes "google". Google button grayed out (opacity 0.45) with "Already used" note. Apple and email still enabled.',
        tags: ['edge-case', 'disabled'],
        steps: [
          'Login screen — "Create account" tapped',
          'Signup picker — Google grayed out, Apple and email enabled',
        ],
      },
      {
        key: '08-signup-both-sso-disabled',
        title: 'Both SSO methods disabled',
        desc: 'Both Google and Apple already registered. Email is the only active path.',
        tags: ['edge-case', 'disabled'],
        steps: [
          'Login screen — "Create account" tapped',
          'Signup picker — Google and Apple both grayed out, only email active',
        ],
      },
    ],
  },
  {
    name: 'Signup — Email Entry',
    tests: [
      {
        key: '09-signup-email-form',
        title: 'Email form (empty)',
        desc: '"Send verification code" button disabled until input is non-empty.',
        tags: [],
        steps: [
          'Login screen',
          'Signup method picker',
          'Email form — button disabled until address is filled',
        ],
      },
      {
        key: '10-signup-email-invalid',
        title: 'Invalid format',
        desc: 'Input "bla@bla." fails EMAIL_RE — requires non-empty TLD segment after the last dot.',
        tags: ['validation', 'error'],
        steps: [
          'Login screen',
          'Signup picker',
          'Email form — invalid address "bla@bla." typed',
          'Validation error: invalid email format',
        ],
      },
      {
        key: '11-signup-email-reserved',
        title: 'Reserved address',
        desc: 'google@, apple@, and bank@munni.app are blocked. Error: "This email address cannot be used for sign-up."',
        tags: ['validation', 'error', 'edge-case'],
        steps: [
          'Login screen',
          'Signup picker',
          'Email form — reserved address "bank@munni.app" typed',
          'Error: this address cannot be used for sign-up',
        ],
      },
      {
        key: '12-signup-email-exists',
        title: 'Address already registered',
        desc: 'Email found in munni_signup_emails. Error with inline "Sign in instead" CTA that pre-fills the email-input login screen.',
        tags: ['error', 'edge-case'],
        steps: [
          'Login screen',
          'Signup method picker',
          'Email form — existing address typed',
          'Error: address already registered — "Sign in instead" CTA',
        ],
      },
    ],
  },
  {
    name: 'Verification',
    tests: [
      {
        key: '13-verify-filling',
        title: 'Auto-fill — in progress',
        desc: 'Digits filling at 100 ms/digit. "Auto-filling code…" label visible. Sequence begins after 200 ms initial + 300 ms delay.',
        tags: ['animation', 'state'],
        steps: [
          'Login screen',
          'Signup picker',
          'Email form — new address submitted',
          'Verification screen — code auto-filling in progress',
        ],
      },
      {
        key: '14-verify-complete',
        title: 'Auto-fill — complete',
        desc: 'All 6 digits filled (signup code: 739251). Transitions to onboarding 800 ms after the last digit.',
        tags: ['state'],
        steps: [
          'Login screen',
          'Signup picker',
          'Email form — new address submitted',
          'Verification screen — all 6 digits filled',
        ],
      },
      {
        key: '15-verify-login',
        title: 'Login OTP — complete',
        desc: 'Returning email user. Login code: 427183. Same timing. Transitions to home after 800 ms.',
        tags: ['state'],
        steps: [
          'Login screen — known address entered',
          'Email submitted — OTP sent',
          'OTP auto-filling complete (login code: 427183)',
        ],
      },
    ],
  },
  {
    name: 'Email Input (dedicated)',
    tests: [
      {
        key: '16-email-input-screen',
        title: 'Dedicated sign-in screen',
        desc: 'Reached only via "Sign in instead" after signup attempt fails. Email is pre-filled.',
        tags: ['navigation', 'edge-case'],
        steps: [
          'Login screen',
          'Signup picker',
          'Email form — existing address entered',
          'Signup error — "Sign in instead" CTA visible',
          'Dedicated sign-in screen — address pre-filled',
        ],
      },
      {
        key: '17-email-input-error',
        title: 'Not found error',
        desc: 'Different address entered, no account. Same "No account found" error with "Create account" CTA.',
        tags: ['error', 'edge-case'],
        steps: [
          'Login screen',
          'Signup picker',
          'Email form — existing address entered',
          'Signup error — click "Sign in instead"',
          'Sign-in screen — different (unknown) address entered',
          'Error: no account found for this address',
        ],
      },
    ],
  },
  {
    name: 'No Account Found',
    tests: [
      {
        key: '18-no-account-google',
        title: 'No Google account',
        desc: 'Google pressed but no account registered with that method. Shows explanation + "Continue with Google" and "Use email instead" CTAs.',
        tags: ['edge-case'],
        steps: [
          'Login screen — Google button tapped',
          'No Google account found — two-CTA recovery screen',
        ],
      },
      {
        key: '19-no-account-apple',
        title: 'No Apple account',
        desc: 'Same as Google variant but for Apple. Logo, colour scheme, and button label differ.',
        tags: ['edge-case'],
        steps: [
          'Login screen — Apple button tapped',
          'No Apple account found — two-CTA recovery screen',
        ],
      },
    ],
  },
];
