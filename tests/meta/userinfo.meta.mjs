export const FEATURE       = 'userinfo';
export const FEATURE_LABEL = 'My Profile';

export const GROUPS = [
  {
    name: 'Country Field',
    tests: [
      {
        key: '01-userinfo-country-picker',
        title: 'Country field — open picker and select',
        desc: 'Navigate to Settings → My Profile → tap the Country row → country picker sheet opens. Select "Germany" → sheet closes, Germany flag + name shown in the row.',
        tags: ['ui', 'state'],
        steps: [
          'My Profile — country row (no selection)',
          'Country picker sheet open',
          'My Profile — Germany selected',
        ],
      },
      {
        key: '02-userinfo-country-search',
        title: 'Country picker — search with highlight',
        desc: 'Type "Ger" in country search → list filters to Germany; "Ger" is highlighted in the result. Select Germany → sheet closes, selection retained after Save.',
        tags: ['ui', 'state', 'search'],
        steps: [
          'Country picker — search box',
          '"Ger" typed — filtered list with highlight',
          'My Profile — Germany retained after save',
        ],
      },
    ],
  },
];
