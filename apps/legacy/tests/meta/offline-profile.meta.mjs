export const FEATURE       = 'offline-profile';
export const FEATURE_LABEL = 'Offline Profile';

export const GROUPS = [
  {
    name: 'Profile Layout',
    tests: [
      {
        key: '71-offline-profile-layout',
        title: 'Offline profile view',
        desc: 'Settings › My Profile for an offline user shows username field; hides country, API section, and account info. Encryption key and Data sections are visible.',
        tags: [],
      },
    ],
  },
  {
    name: 'Encryption Key',
    tests: [
      {
        key: '72-offline-key-section',
        title: 'Key hidden by default',
        desc: 'Encryption key section shows eight bullet blocks (••••) by default. The eye toggle and Regenerate key row are both visible.',
        tags: [],
        steps: [
          'Key section loaded',
          'Key section — assertions passed',
        ],
      },
      {
        key: '73-offline-key-toggle',
        title: 'Eye toggle reveal/hide',
        desc: 'Tapping the eye icon reveals the full hex key across two rows (4 blocks each). Tapping again returns to bullets.',
        tags: ['state'],
        steps: [
          'Key hidden (default)',
          'Key revealed after eye tap',
          'Key hidden again after second tap',
        ],
      },
      {
        key: '74-offline-key-info',
        title: 'Key info sheet',
        desc: 'Tapping the info (ⓘ) button next to the section heading opens a sheet explaining what the encryption key is and why it matters.',
        tags: [],
        steps: [
          'Profile screen',
          'Key info sheet open',
        ],
      },
      {
        key: '75-offline-key-regen-sheet',
        title: 'Regenerate key warning sheet',
        desc: 'Tapping "Regenerate key" opens a warning sheet explaining that old backups remain tied to the current key. Confirm and Cancel CTAs are visible.',
        tags: [],
        steps: [
          'Profile screen',
          'Regenerate key warning sheet open',
        ],
      },
      {
        key: '76-offline-key-regen-confirm',
        title: 'Confirm regen closes sheet',
        desc: 'Tapping "Generate new key" dismisses the warning sheet. The key section remains visible with a freshly generated key.',
        tags: ['state'],
        steps: [
          'Regen warning sheet',
          'Sheet dismissed — new key active',
        ],
      },
    ],
  },
  {
    name: 'Backup',
    tests: [
      {
        key: '77-offline-backup-sheet',
        title: 'Backup sheet opens',
        desc: 'Tapping "Backup data" opens a sheet showing the current key preview and a "Save backup file" CTA that triggers a .mun download.',
        tags: [],
        steps: [
          'Profile screen',
          'Backup sheet open',
        ],
      },
    ],
  },
  {
    name: 'Recover (from profile)',
    tests: [
      {
        key: '78-offline-recover-sheet',
        title: 'Recover sheet opens',
        desc: 'Tapping "Recover from backup" opens a multi-step recover sheet starting on the file-picker step.',
        tags: [],
        steps: [
          'Profile screen',
          'Recover sheet — file step',
        ],
      },
      {
        key: '79-offline-recover-flow',
        title: 'File + key → success',
        desc: 'Full recover flow: upload a .mun file, advance to key step, enter key, confirm → loading animation → success state.',
        tags: ['state'],
        steps: [
          'Recover sheet — key step (file already selected)',
          'Success state',
        ],
      },
    ],
  },
  {
    name: 'Auto-Backup',
    tests: [
      {
        key: '80-offline-auto-backup-sheet',
        title: 'Auto-backup sheet opens',
        desc: 'Tapping "Auto backup" opens a configuration sheet with Frequency and Storage location sections.',
        tags: [],
        steps: [
          'Profile screen',
          'Auto-backup sheet open',
        ],
      },
      {
        key: '81-offline-auto-backup-save',
        title: 'Select options and save',
        desc: 'Changing frequency to Weekly and location to Google Drive, then tapping Save closes the sheet.',
        tags: ['state'],
        steps: [
          'Auto-backup sheet — defaults',
          'Weekly + Google Drive selected',
          'Sheet dismissed after save',
        ],
      },
    ],
  },
  {
    name: 'Recover from Creator (App-level)',
    tests: [
      {
        key: '82-offline-create-recover-btn',
        title: 'Recover btn on create screen',
        desc: 'The offline profile create screen shows a "Recover from backup" button below a divider, letting users restore instead of creating fresh.',
        tags: [],
      },
      {
        key: '83-offline-recover-screen',
        title: 'Recover screen opens',
        desc: 'Tapping "Recover from backup" on the create screen navigates to the standalone recover screen with the file-picker step.',
        tags: ['navigation'],
      },
      {
        key: '84-offline-recover-back',
        title: 'Browser back → create screen',
        desc: 'Pressing browser back on the recover screen returns to the offline create screen.',
        tags: ['navigation'],
        steps: [
          'Recover screen',
          'Back to create screen',
        ],
      },
      {
        key: '85-offline-recover-complete',
        title: 'Full recover → home',
        desc: 'Upload .mun file, enter key, confirm → success state → tap "Go to munni" → lands on home screen as offline user.',
        tags: ['state'],
        steps: [
          'Recover key step',
          'Success state',
          'Home screen after restore',
        ],
      },
    ],
  },
];
