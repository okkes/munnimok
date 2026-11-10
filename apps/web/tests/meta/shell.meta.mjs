export const FEATURE       = 'shell';
export const FEATURE_LABEL = 'App Shell';

export const GROUPS = [
  {
    name: 'Navigation',
    tests: [
      {
        key: '01-shell-home',
        title: 'Home tab (default)',
        desc: 'App boots to the Home tab with the bottom tab bar (mobile) and URL routed to #/home.',
        tags: ['first-run'],
      },
      {
        key: '02-shell-tabs',
        title: 'Tab navigation',
        desc: 'Tapping each tab switches screens: Transactions → Planning → Settings.',
        tags: ['navigation'],
        steps: [
          'Transactions tab',
          'Planning tab',
          'Settings tab',
        ],
      },
      {
        key: '03-shell-back',
        title: 'Browser back between tabs',
        desc: 'Every screen has a real URL, so the browser/device back button returns to the previous tab.',
        tags: ['navigation'],
        steps: [
          'Transactions tab opened',
          'Browser back → Home tab',
        ],
      },
    ],
  },
  {
    name: 'Offline profile',
    tests: [
      {
        key: '38-offline',
        title: 'Offline mode lifecycle',
        desc: 'Create a fully local profile (zero network, ever): its first space, an account and a transaction work offline, signing out keeps the data, and the profile is selectable again on the login screen.',
        tags: ['state', 'edge-case'],
        steps: [
          'Naming the offline profile',
          'Offline transaction added',
          'Data intact after sign-out and re-entry',
        ],
      },
    ],
  },
];
