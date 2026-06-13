export const FEATURE       = 'spaces';
export const FEATURE_LABEL = 'Spaces';

export const GROUPS = [
  {
    name: 'Spaces list',
    tests: [
      {
        key: '01-spaces-list-single',
        title: 'Single demo space',
        desc: 'Default demo login — one Demo-badged space visible. Active indicator (green check) present.',
        tags: ['first-run'],
      },
      {
        key: '02-spaces-list-multiple',
        title: 'Multiple spaces — active indicator',
        desc: 'Two spaces in the list. The active one shows the green check badge on the right. Inactive space has no badge.',
        tags: [],
      },
      {
        key: '03-spaces-list-shared-badge',
        title: 'Shared badge on space with members',
        desc: 'When a space has a members array with other users, a "Shared" pill badge appears next to the space name.',
        tags: ['state'],
      },
      {
        key: '04-spaces-list-invite',
        title: 'Pending invite section',
        desc: 'If the current user has a pending profile invitation, an "Invitations" section appears above the spaces list with Join and Decline buttons.',
        tags: ['state', 'edge-case'],
      },
    ],
  },
  {
    name: 'New space sheet',
    tests: [
      {
        key: '05-spaces-new-sheet-empty',
        title: 'Sheet opens — empty state',
        desc: 'Tapping + opens the new space sheet. Name input is empty, Create button is styled as disabled (gray background).',
        tags: [],
        steps: [
          'Spaces list',
          'New space sheet — empty name field',
        ],
      },
      {
        key: '06-spaces-new-name-typed',
        title: 'Name typed — create enabled',
        desc: 'After entering a name, the Create button turns green (M.sage background), signalling it is now tappable.',
        tags: ['state'],
        steps: [
          'Spaces list',
          'New space sheet — "Work" typed in name field',
        ],
      },
      {
        key: '07-spaces-new-demo-type',
        title: 'Demo type pre-selected (demo user)',
        desc: 'For bank/demo login users, the Real type button is grayed out (opacity 0.5) and unclickable. Demo type is selected by default.',
        tags: ['edge-case', 'state'],
      },
      {
        key: '08-spaces-new-name-too-long',
        title: 'Name too long — error',
        desc: '31-character name exceeds the 30-char limit. Error: "Name cannot exceed 30 characters" shown in red below the input.',
        tags: ['validation', 'error'],
        steps: [
          'Spaces list',
          'New space sheet — 31-char name submitted',
          'Error: name too long',
        ],
      },
      {
        key: '09-spaces-new-invalid-chars',
        title: 'Invalid characters — error',
        desc: 'PROFILE_NAME_RE only allows letters, numbers, spaces, hyphens, and apostrophes. "@" triggers "Only letters, numbers, spaces…" error.',
        tags: ['validation', 'error'],
        steps: [
          'Spaces list',
          'New space sheet — "Work@2025" submitted',
          'Error: invalid characters',
        ],
      },
      {
        key: '10-spaces-new-duplicate',
        title: 'Duplicate name — error',
        desc: 'Case-insensitive match against existing own (non-shared) spaces. "personal" matches "Personal" → "A space with this name already exists".',
        tags: ['validation', 'error', 'edge-case'],
        steps: [
          'Spaces list (2 spaces: Personal + Business)',
          'New space sheet — "personal" (lowercase) submitted',
          'Error: duplicate name',
        ],
      },
      {
        key: '11-spaces-new-real-disabled',
        title: 'Real type locked for demo user',
        desc: 'Demo users (bank login) cannot create Real spaces. Real button has opacity 0.5 and cursor:not-allowed; clicking it has no effect.',
        tags: ['edge-case', 'disabled'],
      },
    ],
  },
  {
    name: 'Invite flow',
    tests: [
      {
        key: '12-spaces-invite-join-sheet',
        title: 'Join opens rename-invite sheet',
        desc: 'Tapping "Join" on a pending invite opens the rename-invite sheet where the user can give the shared space a local nickname before accepting.',
        tags: ['navigation'],
        steps: [
          'Spaces list — pending invite visible',
          'Rename-invite sheet open',
        ],
      },
      {
        key: '13-spaces-invite-decline',
        title: 'Decline removes invite from list',
        desc: 'Tapping "Decline" marks the invitation as declined. The filter excludes non-pending invites, so the section disappears immediately.',
        tags: ['edge-case'],
        steps: [
          'Spaces list — one pending invite',
          'Decline clicked — invite section gone',
        ],
      },
    ],
  },
  {
    name: 'Space detail',
    tests: [
      {
        key: '14-spaces-detail-active-only',
        title: 'Active + only space — delete disabled',
        desc: 'Both isActive and isOnly are true. Delete button is disabled (gray) with "Cannot delete your only space" hint below.',
        tags: ['edge-case', 'disabled'],
      },
      {
        key: '15-spaces-detail-inactive',
        title: 'Inactive space — delete enabled',
        desc: 'Second space that is not active — isActive is false. Delete button is enabled (clay red background).',
        tags: ['state'],
      },
      {
        key: '16-spaces-detail-demo-space',
        title: 'Demo space — invite locked',
        desc: 'isDemo spaces show a locked members section with a padlock icon and the message "Demo spaces cannot have members" instead of the invite flow.',
        tags: ['state', 'edge-case'],
      },
      {
        key: '17-spaces-detail-rename',
        title: 'Tap name → edit mode',
        desc: 'Tapping the space name (with dashed underline) transitions to an inline input field (autoFocus). The input pre-fills with the current name.',
        tags: ['state'],
        steps: [
          'Space detail — name displayed with dashed underline',
          'Name tapped — input field active',
        ],
      },
      {
        key: '18-spaces-detail-rename-error',
        title: 'Rename — name too long error',
        desc: '31-char input triggers "Name cannot exceed 30 characters" inline error below the name input. Input border turns clay red.',
        tags: ['validation', 'error'],
        steps: [
          'Space detail — name tapped, edit mode',
          '31-char name entered and Enter pressed',
          'Error below input: name too long',
        ],
      },
      {
        key: '19-spaces-detail-delete-confirm',
        title: 'Delete confirm sheet',
        desc: 'Tapping the Delete button opens a Sheet with the space name, a summary of data that will also be deleted (budgets/goals/debts), and a red Confirm Delete button.',
        tags: ['navigation'],
        steps: [
          'Space detail — inactive space',
          'Delete tapped → confirm sheet open',
        ],
      },
      {
        key: '20-spaces-detail-leave-confirm',
        title: 'Leave confirm sheet (shared space)',
        desc: 'For a shared space the user is a member of, tapping "Leave" opens a Sheet asking to confirm leaving. Content differs for owner-transfer vs. regular leave.',
        tags: ['navigation', 'edge-case'],
        steps: [
          'Space detail — shared space (user is member)',
          'Leave tapped → confirm sheet open',
        ],
      },
    ],
  },
  {
    name: 'Navigation',
    tests: [
      {
        key: '21-spaces-back-from-detail',
        title: 'Back from detail → spaces list',
        desc: 'Browser back from space detail pops the stack and restores the spaces list. The spaces-screen is visible again.',
        tags: ['navigation'],
        steps: [
          'Space detail open',
          'Browser back → spaces list',
        ],
      },
      {
        key: '22-spaces-back-from-list',
        title: 'Back from list → profile',
        desc: 'Browser back from the spaces list pops the stack and returns to the profile screen. The spaces nav link is visible again.',
        tags: ['navigation'],
        steps: [
          'Spaces list open',
          'Browser back → profile screen',
        ],
      },
    ],
  },
];
