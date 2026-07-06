export const FEATURE       = 'sync';
export const FEATURE_LABEL = 'Multi-Device Sync';

export const GROUPS = [
  {
    name: 'Two-Device Sync (real API + Postgres)',
    tests: [
      {
        key: '25-sync-devices',
        title: 'Devices converge in both directions',
        desc: 'Device A creates an account; device B (fresh browser, same user) discovers the space from the server and pulls it. B renames the account; A sees the rename. Runs against the containerized API with a real database.',
        tags: ['state', 'edge-case'],
        steps: [
          'Device A after creating the account',
          'Device B pulled it',
          'Device A sees B’s rename',
        ],
      },
      {
        key: '26-sync-single-space',
        title: 'No duplicate personal space',
        desc: 'A returning user on a brand-new device pulls their existing personal space instead of creating a second one.',
        tags: ['edge-case'],
      },
    ],
  },
];
