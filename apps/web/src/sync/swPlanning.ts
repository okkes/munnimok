import { MunniDB, identityDbName } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import type { StorageBackend } from '@/db/backend';
import { appendNotification } from '@/application/notifications';
import { buildPlanning, hasCurrentPlan, loadPlanningData, localIsoToday } from '@/application/planningModel';
import type { Lang } from '@/i18n';
import { readSwSession } from './swSync';

/**
 * Planning alerts (#128): a subject of the current plan is in the red —
 * spent more than it holds. One notice per space per day, both as an
 * in-app inbox row and (permission allowing) an OS notification; the
 * app's layout and the service worker's push wake-up share this code
 * and the marker, so a day never hears it twice.
 */

const LANGS: readonly Lang[] = ['en', 'nl', 'tr'];

const TEXTS: Record<Lang, { title: string; one: string; many: string }> = {
  en: { title: 'munni', one: '{name} is in the red — cover it in your plan', many: '{n} subjects of your plan are in the red: {names}' },
  nl: { title: 'munni', one: '{name} staat rood — dek het in je plan', many: '{n} onderwerpen van je plan staan rood: {names}' },
  tr: { title: 'munni', one: '{name} eksiye düştü — planında karşıla', many: 'Planındaki {n} konu eksiye düştü: {names}' },
};

export interface PlanAlert {
  title: string;
  body: string;
  /** coalescing tag, unique per space and day */
  tag: string;
  url: string;
}

const markerKey = (spaceId: string, today: string) => `planOverspentNotified_${spaceId}_${today}`;

/**
 * The red subjects of `spaceId`'s current plan, if today has not been
 * told yet. Records the inbox row and stamps the marker when it returns one.
 */
export async function collectPlanAlerts(store: StorageBackend, spaceId: string, lang: string, today = localIsoToday()): Promise<PlanAlert[]> {
  if (!(await hasCurrentPlan(store, spaceId))) return [];
  const key = markerKey(spaceId, today);
  if (await store.metaGet(key)) return [];
  const model = buildPlanning(await loadPlanningData(store, spaceId), today);
  const red = model.attention;
  if (red.length === 0) return [];
  await store.metaPut(key, Date.now());

  const safeLang: Lang = LANGS.find((known) => known === lang) ?? 'en';
  const texts = TEXTS[safeLang];
  const names = red.map((v) => v.subject.name);
  const body =
    red.length === 1
      ? texts.one.replace('{name}', names[0])
      : texts.many.replace('{n}', String(red.length)).replace('{names}', names.join(', '));
  await appendNotification(store, 'planOverspent', { n: String(red.length), names: names.join(', ') }, key);
  return [{ title: texts.title, body, tag: `plan-${spaceId}-${today}`, url: './#/planning' }];
}

/** worker entry: resolve the mirrored session's database, then collect */
export async function evaluatePlanAlertsFromWorker(spaceId: string | undefined, lang: string): Promise<PlanAlert[]> {
  if (!spaceId) return [];
  const session = await readSwSession();
  if (!session) return [];
  const store = new DexieBackend(new MunniDB(identityDbName(session.identityKey)));
  try {
    return await collectPlanAlerts(store, spaceId, lang);
  } finally {
    store.close();
  }
}
