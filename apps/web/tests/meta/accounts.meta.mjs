export const FEATURE       = 'accounts';
export const FEATURE_LABEL = 'All accounts';

export const GROUPS = [
  {
    name: 'Accounts',
    tests: [
      {
        key: '16-accounts-list',
        title: 'Assets & liabilities list',
        desc: 'Settings → All accounts lists accounts grouped into Assets and Liabilities with balances and IBANs.',
        tags: ['state'],
      },
      {
        key: '17-accounts-add',
        title: 'Add manual account',
        desc: 'A space’s Add account offers connect a bank, import a statement or a manual account (#527); Manual opens the type grid, and picking Cash Wallet shows the manual form (name + starting balance, comma decimals accepted). The new account appears in the list and in the Home total.',
        tags: ['state'],
        steps: [
          'Add account: connect, import or manual',
          'Account type grid',
          'Manual account form',
        ],
      },
    ],
  },
];
