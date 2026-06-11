export const FEATURE       = 'offline';
export const FEATURE_LABEL = 'Offline Mode';

export const GROUPS = [
  {
    name: 'Login Entry Point',
    tests: [
      {
        key: '60-offline-login-btn',
        title: 'Offline button on login',
        desc: 'Login screen shows the "Offline mode" button with a lock icon below the main sign-in methods.',
        tags: [],
      },
    ],
  },
  {
    name: 'Offline Info Screen',
    tests: [
      {
        key: '61-offline-info',
        title: 'Info screen opens',
        desc: 'Tapping "Offline mode" reveals the info screen: ownership pitch, four limitations listed, pricing note, Continue and Back CTAs.',
        tags: [],
        steps: [
          'Login screen',
          'Offline info screen opened',
        ],
      },
      {
        key: '62-offline-info-back',
        title: 'Back button returns to login',
        desc: 'Tapping the Back CTA on the info screen navigates back to the main login screen.',
        tags: ['navigation'],
        steps: [
          'Offline info screen',
          'Back to login screen',
        ],
      },
      {
        key: '63-offline-info-browser-back',
        title: 'Browser back returns to login',
        desc: 'Pressing the browser/device back button from the info screen pops the history entry and returns to login.',
        tags: ['navigation'],
        steps: [
          'Offline info screen',
          'Browser back → login screen',
        ],
      },
    ],
  },
  {
    name: 'Offline Profile Creator',
    tests: [
      {
        key: '64-offline-create',
        title: 'Create screen opens',
        desc: 'Tapping "Continue offline" on the info screen shows the profile creator: name input, avatar picker, Create CTA, and Recover from backup option.',
        tags: [],
        steps: [
          'Login screen',
          'Offline create screen',
        ],
      },
      {
        key: '65-offline-create-name-error',
        title: 'Name required error',
        desc: 'Submitting the create form without a name shows a validation error. The user remains on the create screen.',
        tags: ['validation', 'error'],
        steps: [
          'Create screen — empty name',
          'Submit tapped (no name)',
          'Error message shown',
        ],
      },
      {
        key: '66-offline-create-flow',
        title: 'Full create flow → home',
        desc: 'Complete happy path: login → info → create screen → fill name → submit → lands on home with offline banner.',
        tags: [],
        steps: [
          'Login screen',
          'Offline info screen',
          'Create screen — name filled',
          'Home screen with offline banner',
        ],
      },
    ],
  },
  {
    name: 'Home Offline Banner',
    tests: [
      {
        key: '67-offline-home-banner',
        title: 'Offline banner on home',
        desc: 'After creating an offline profile the home screen shows the "Offline" banner with "Data stored on this device only." subtitle.',
        tags: [],
        steps: [
          'Home — banner area before assertion',
          'Home — offline banner confirmed visible',
        ],
      },
    ],
  },
  {
    name: 'Offline Profile Selector',
    tests: [
      {
        key: '68-offline-select',
        title: 'Select screen with profiles',
        desc: 'When offline profiles exist and no online methods are registered, the app boots straight to the profile selector.',
        tags: [],
      },
      {
        key: '69-offline-select-login',
        title: 'Tap profile → home',
        desc: 'Tapping an existing profile tile on the selector logs the user in and navigates to the home screen.',
        tags: ['navigation'],
        steps: [
          'Profile selector',
          'Home screen after profile tap',
        ],
      },
      {
        key: '70-offline-boot-select',
        title: 'Auto-boot to selector',
        desc: 'With only offline profiles and no online signup methods, the app shows the selector on first load — skipping the login screen entirely.',
        tags: [],
      },
    ],
  },
];
