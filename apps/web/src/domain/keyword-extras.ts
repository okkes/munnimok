import { KEYWORD_RULES } from './keyword-categories';
import type { KeywordRule } from './keyword-categories';

/**
 * Keyword rules written here, by hand: the generated table next door was a
 * one-shot port of the legacy predictor's data and is not edited. A rule
 * per language, the same shape; the predictor reads the two tables as one.
 */
export const EXTRA_KEYWORD_RULES: KeywordRule[] = [
  // #451: activities — things you go and do, as opposed to a film, a concert or a match
  {
    lang: 'nl',
    catId: 'activities',
    keywords: ['bowling', 'escape room', 'escaperoom', 'pretpark', 'attractiepark', 'efteling', 'walibi', 'toverland', 'slagharen', 'dierentuin', 'dierenpark', 'artis', 'blijdorp', 'ouwehands', 'museum', 'klimhal', 'klimpark', 'boulderhal', 'lasergame', 'lasergamen', 'karten', 'kartbaan', 'minigolf', 'glowgolf', 'trampolinepark', 'jumpsquare', 'paintball', 'schaatsbaan', 'speeltuin', 'monkey town', 'ballorig'],
  },
  {
    lang: 'en',
    catId: 'activities',
    keywords: ['bowling', 'escape room', 'theme park', 'amusement park', 'zoo', 'museum', 'climbing gym', 'bouldering', 'laser tag', 'go-kart', 'karting', 'mini golf', 'minigolf', 'trampoline park', 'paintball', 'ice rink', 'playground', 'aquarium'],
  },
  {
    lang: 'tr',
    catId: 'activities',
    keywords: ['bowling', 'kaçış odası', 'lunapark', 'tema parkı', 'hayvanat bahçesi', 'müze', 'tırmanış', 'lazer tag', 'go-kart', 'karting', 'mini golf', 'trambolin', 'paintball', 'buz pisti', 'akvaryum'],
  },
];

/** every rule the predictor reads: the generated table and the hand-written one */
export const ALL_KEYWORD_RULES: readonly KeywordRule[] = [...KEYWORD_RULES, ...EXTRA_KEYWORD_RULES];
