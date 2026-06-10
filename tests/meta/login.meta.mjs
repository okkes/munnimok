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
      },
      {
        key: '04-login-sso-loading',
        title: 'Google SSO — loading',
        desc: 'Full-screen state shown for 1400 ms while the app simulates the SSO handshake. Three pulsing dots animate below the provider logo.',
        tags: ['state', 'animation'],
      },
      {
        key: '05-login-sso-loading-apple',
        title: 'Apple SSO — loading',
        desc: 'Same loading screen for Apple. Provider logo and dot color differ from Google.',
        tags: ['state', 'animation'],
      },
    ],
  },
  {
    name: 'Signup — Method Picker',
    tests: [
      {
        key: '06-signup-picker',
        title: 'Method picker (empty)',
        desc: 'No prior accounts. All three options available: Google, Apple, and email.',
        tags: ['first-run'],
      },
      {
        key: '07-signup-google-disabled',
        title: 'Google already registered',
        desc: 'munni_signup_methods includes "google". Google button grayed out (opacity 0.45) with "Already used" note. Apple and email still enabled.',
        tags: ['edge-case', 'disabled'],
      },
      {
        key: '08-signup-both-sso-disabled',
        title: 'Both SSO methods disabled',
        desc: 'Both Google and Apple already registered. Email is the only active path.',
        tags: ['edge-case', 'disabled'],
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
      },
      {
        key: '10-signup-email-invalid',
        title: 'Invalid format',
        desc: 'Input "bla@bla." fails EMAIL_RE — requires non-empty TLD segment after the last dot.',
        tags: ['validation', 'error'],
      },
      {
        key: '11-signup-email-reserved',
        title: 'Reserved address',
        desc: 'google@, apple@, and bank@munni.app are blocked. Error: "This email address cannot be used for sign-up."',
        tags: ['validation', 'error', 'edge-case'],
      },
      {
        key: '12-signup-email-exists',
        title: 'Address already registered',
        desc: 'Email found in munni_signup_emails. Error with inline "Sign in instead" CTA that pre-fills the email-input login screen.',
        tags: ['error', 'edge-case'],
        // Step replay (en-light-mobile only): intermediate screenshots captured during this test.
        // Each label maps to: --s1, --s2, ..., final (no suffix).
        steps: [
          'Start: Login screen',
          'Signup method picker',
          'Email form open',
          'Error: address already registered',
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
      },
      {
        key: '14-verify-complete',
        title: 'Auto-fill — complete',
        desc: 'All 6 digits filled (signup code: 739251). Transitions to onboarding 800 ms after the last digit.',
        tags: ['state'],
      },
      {
        key: '15-verify-login',
        title: 'Login OTP — complete',
        desc: 'Returning email user. Login code: 427183. Same timing. Transitions to home after 800 ms.',
        tags: ['state'],
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
      },
      {
        key: '17-email-input-error',
        title: 'Not found error',
        desc: 'Different address entered, no account. Same "No account found" error with "Create account" CTA.',
        tags: ['error', 'edge-case'],
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
      },
      {
        key: '19-no-account-apple',
        title: 'No Apple account',
        desc: 'Same as Google variant but for Apple. Logo, colour scheme, and button label differ.',
        tags: ['edge-case'],
      },
    ],
  },
];
