export const FEATURE       = 'planning';
export const FEATURE_LABEL = 'Planning';

export const GROUPS = [
  {
    name: 'The plan',
    tests: [
      {
        key: '70-planning',
        title: 'This period’s plan',
        desc: 'The pool of checking and cash money handed out to the plan’s subjects — recurring costs and debts first, then the person’s own expenses, budgets and goals. The head shows what is left to give a job; the circle counts the periods funded ahead.',
        tags: ['planning', 'demo'],
      },
      {
        key: '71-planning-subject',
        title: 'A subject opened',
        desc: 'What the subject holds against its target and what was spent; set an amount, fill to target, cover an overspend from a subject with room, snooze a mirrored subject, edit or remove an expense subject.',
        tags: ['planning'],
      },
      {
        key: '72-planning-ahead',
        title: 'Periods ahead',
        desc: 'Money set aside for the periods to come, filled in the plan’s order from what is left; fund the next period, take one back, push the plan’s shape into all of them.',
        tags: ['planning'],
      },
    ],
  },
];
