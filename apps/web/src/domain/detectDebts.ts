// #192: a detected payment pattern whose creditor is a known lender (seed: DUO, the Dutch student-loan agency) reads as a
// loan, not a subscription; word-bounded so "Duolingo" never matches
const DEBT_CREDITOR_PATTERNS: readonly RegExp[] = [
  /\bduo\b/i,
  /dienst\s+uitvoering\s+onderwijs/i,
];

export const looksLikeDebtCreditor = (name: string): boolean =>
  DEBT_CREDITOR_PATTERNS.some((pattern) => pattern.test(name));
