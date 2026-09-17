export const FEATURE       = 'demo';
export const FEATURE_LABEL = 'Demo User';

export const GROUPS = [
  {
    name: 'Demo Login & Data',
    tests: [
      {
        key: '06-demo-login',
        title: 'Continue as demo user',
        desc: 'Login gate offers "Continue as demo user"; entering seeds the on-device database (2 accounts, 100 transactions) and Home shows the €11,570.55 total.',
        tags: ['first-run'],
        steps: [
          'Login screen',
          'Home with seeded balance',
        ],
      },
    ],
  },
];
