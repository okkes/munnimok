export const FEATURE       = 'transactions';
export const FEATURE_LABEL = 'Transactions';

export const GROUPS = [
  {
    name: 'Transaction Detail',
    tests: [
      {
        key: '09-tx-detail',
        title: 'Detail opens and back returns',
        desc: 'Tapping a row opens the detail screen (amount hero, category, account, bank description, notes); browser back returns to the list.',
        tags: ['navigation'],
        steps: [
          'Detail screen',
          'Back to list',
        ],
      },
      {
        key: '10-tx-recat',
        title: 'Recategorize clears review flag',
        desc: 'The category row opens the picker sheet; choosing a category updates the transaction and clears the needs-review badge.',
        tags: ['state'],
        steps: [
          'Category picker sheet',
          'Detail with new category',
        ],
      },
      {
        key: '11-tx-cat-search',
        title: 'Category picker search',
        desc: 'Typing in the picker search filters categories across all groups.',
        tags: ['state'],
      },
      {
        key: '12-tx-notes',
        title: 'Notes persist',
        desc: 'Notes save on blur into the local database and survive leaving and reopening the transaction.',
        tags: ['state'],
      },
    ],
  },
];
