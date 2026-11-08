export const FEATURE       = 'transactions';
export const FEATURE_LABEL = 'Transactions';

export const GROUPS = [
  {
    name: 'Transaction Detail',
    tests: [
      {
        key: '09-tx-detail',
        title: 'A transaction’s own page',
        desc: 'Saving a new transaction opens its detail (amount hero, category, account, bank description, notes); back returns to the list.',
        tags: ['navigation'],
      },
    ],
  },
  {
    name: 'Manual Transactions',
    tests: [
      {
        key: '27-tx-create',
        title: 'Add a manual transaction',
        desc: 'The + button opens a screen of its own (#348): sign toggle, amount (EU decimals), name, date, account, then the category — the counterparty opens once the category is a movement — and the event, a note and the reimbursement link. Saving opens the new transaction.',
        tags: ['state'],
        steps: [
          'Filled form',
          'The new transaction',
        ],
      },
      {
        key: '28-tx-edit',
        title: 'Edit a manual transaction',
        desc: 'Manual transactions get a pencil in the detail header; amount, name, date, account and category are editable in a sheet (the counterparty opens once the category is a movement). Bank-imported rows stay read-only (their data is the bank’s truth).',
        tags: ['state', 'edge-case'],
      },
      {
        key: '34-tx-reimburse',
        title: 'Link a reimbursement',
        desc: 'Expenses can link credit transactions as (partial) reimbursements: amounts are clamped to what is possible, the hero shows the net cost with the gross struck through, and unlinking restores it. The picker lists every open row and jumps to the day of the transaction (#502).',
        tags: ['state'],
      },
      {
        key: '35-tx-type-link',
        title: 'Counter-account locks the type',
        desc: 'Linking a counter-account makes the leg a plain Transfer with the locked Transfer out/in category — the special story (saving, debt) lives on the counter account’s own ledger; unlinking restores free typing.',
        tags: ['state', 'edge-case'],
      },
      {
        key: '36-tx-split',
        title: 'Split across categories',
        desc: 'The split editor partitions a transaction across categories — amounts must sum exactly (remainder chip auto-balances), the largest slice becomes the primary category, and clearing restores a single category.',
        tags: ['state'],
        steps: [
          'Balanced split editor',
          'Detail with breakdown',
        ],
      },
    ],
  },
];
