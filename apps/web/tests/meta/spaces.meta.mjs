export const FEATURE       = 'spaces';
export const FEATURE_LABEL = 'Spaces';

export const GROUPS = [
  {
    name: 'Spaces (local, v1)',
    tests: [
      {
        key: '22-spaces-list',
        title: 'Spaces list with active marker',
        desc: 'The Spaces tab lists all spaces; the active one is highlighted. Sharing with other people arrives with the sync server (Phase 2).',
        tags: ['state'],
      },
      {
        key: '23-spaces-create',
        title: 'Create and switch spaces',
        desc: 'Creating a space makes it active — Home scopes to it (empty → €0.00). Switching back to the demo space restores its balances, proving per-space data isolation.',
        tags: ['state'],
        steps: [
          'Create sheet',
          'Home scoped to the new empty space',
          'Back on the demo space',
        ],
      },
    ],
  },
];
