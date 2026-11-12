/**
 * Push-notification decisions for the service worker, extracted so the
 * logic is unit-testable (sw.ts itself only runs in a real worker). The
 * app language is mirrored into a tiny IDB store because push workers
 * boot cold — module state would be lost.
 */

export interface PushPayload {
  type?: string;
  spaceId?: string;
  count?: number;
  fromName?: string;
  spaceName?: string;
  role?: string;
  /** #538: what happened in a split, the split it happened in, and — settled, a payment — the receiver's own figure */
  kind?: string;
  splitId?: string;
  splitName?: string;
  currency?: string;
  cents?: number;
}

interface PushTexts {
  title: string;
  one: string;
  many: string;
  friendRequest: string;
  friendAccept: string;
  spaceInvite: string;
  spaceJoin: string;
  memberRemoved: string;
  memberRole: string;
  roles: Record<string, string>;
  someone: string;
  aSpace: string;
  /** the Settings row's test push */
  test: string;
}

const TEXTS: Record<string, PushTexts> = {
  en: {
    title: 'munni',
    one: '1 new transaction arrived',
    many: '{n} new transactions arrived',
    friendRequest: '{name} sent you a friend request',
    friendAccept: '{name} accepted your friend request',
    spaceInvite: '{name} invited you to "{space}"',
    spaceJoin: '{name} joined "{space}"',
    memberRemoved: 'You were removed from "{space}" by {name}',
    memberRole: 'Your role in "{space}" is now {role}',
    roles: { owner: 'owner', contributor: 'contributor', reader: 'reader' },
    someone: 'Someone',
    aSpace: 'a space',
    test: 'Test notification — push reaches this device ✓',
  },
  nl: {
    title: 'munni',
    one: '1 nieuwe transactie ontvangen',
    many: '{n} nieuwe transacties ontvangen',
    friendRequest: '{name} heeft je een vriendschapsverzoek gestuurd',
    friendAccept: '{name} heeft je vriendschapsverzoek geaccepteerd',
    spaceInvite: '{name} heeft je uitgenodigd voor "{space}"',
    spaceJoin: '{name} doet nu mee in "{space}"',
    memberRemoved: '{name} heeft je verwijderd uit "{space}"',
    memberRole: 'Je rol in "{space}" is nu {role}',
    roles: { owner: 'eigenaar', contributor: 'bijdrager', reader: 'lezer' },
    someone: 'Iemand',
    aSpace: 'een ruimte',
    test: 'Testmelding — push bereikt dit apparaat ✓',
  },
  tr: {
    title: 'munni',
    one: '1 yeni işlem geldi',
    many: '{n} yeni işlem geldi',
    friendRequest: '{name} sana arkadaşlık isteği gönderdi',
    friendAccept: '{name} arkadaşlık isteğini kabul etti',
    spaceInvite: '{name} seni "{space}" alanına davet etti',
    spaceJoin: '{name} "{space}" alanına katıldı',
    memberRemoved: '{name} seni "{space}" alanından çıkardı',
    memberRole: '"{space}" alanındaki rolün artık {role}',
    roles: { owner: 'sahip', contributor: 'katkıda bulunan', reader: 'okuyucu' },
    someone: 'Birisi',
    aSpace: 'bir alan',
    test: 'Test bildirimi — anlık bildirim bu cihaza ulaşıyor ✓',
  },
};

/** #538: a split's notices by kind — the twin of the server's wording for the phone apps (FcmTexts) */
const SPLIT_TEXTS: Record<string, Record<string, string>> = {
  en: {
    invited: '{name} invited you to the split "{split}"',
    'join-request': '{name} asks to join "{split}"',
    approved: 'You are in: "{split}"',
    refused: 'Your request to join "{split}" was turned down',
    'invite-accepted': '{name} joined "{split}"',
    'invite-declined': '{name} declined the invitation to "{split}"',
    'settled-get': '"{split}" is settled: you get {amount}',
    'settled-pay': '"{split}" is settled: you pay {amount}',
    'settled-even': '"{split}" is settled: you are even',
    'payment-paid': '{name} marked a payment of {amount} as paid in "{split}"',
    'delete-planned': '{name} is deleting "{split}" — it is gone in 7 days unless an owner stops it',
    'delete-stopped': '"{split}" stays: its deletion was stopped',
    removed: '{name} took you out of "{split}"',
    'made-owner': '{name} made you an owner of "{split}"',
  },
  nl: {
    invited: '{name} heeft je uitgenodigd voor de split "{split}"',
    'join-request': '{name} wil meedoen met "{split}"',
    approved: 'Je doet mee: "{split}"',
    refused: 'Je verzoek om mee te doen met "{split}" is afgewezen',
    'invite-accepted': '{name} doet mee met "{split}"',
    'invite-declined': '{name} heeft de uitnodiging voor "{split}" afgeslagen',
    'settled-get': '"{split}" is afgerekend: je krijgt {amount}',
    'settled-pay': '"{split}" is afgerekend: je betaalt {amount}',
    'settled-even': '"{split}" is afgerekend: je staat quitte',
    'payment-paid': '{name} heeft een betaling van {amount} in "{split}" als betaald gemarkeerd',
    'delete-planned': '{name} verwijdert "{split}" — over 7 dagen is hij weg, tenzij een eigenaar het stopt',
    'delete-stopped': '"{split}" blijft: het verwijderen is gestopt',
    removed: '{name} heeft je uit "{split}" gehaald',
    'made-owner': '{name} heeft je eigenaar gemaakt van "{split}"',
  },
  tr: {
    invited: '{name} seni "{split}" bölüşmesine davet etti',
    'join-request': '{name} "{split}" bölüşmesine katılmak istiyor',
    approved: 'Katıldın: "{split}"',
    refused: '"{split}" bölüşmesine katılma isteğin reddedildi',
    'invite-accepted': '{name} "{split}" bölüşmesine katıldı',
    'invite-declined': '{name} "{split}" davetini reddetti',
    'settled-get': '"{split}" hesaplaşıldı: {amount} alacaksın',
    'settled-pay': '"{split}" hesaplaşıldı: {amount} ödeyeceksin',
    'settled-even': '"{split}" hesaplaşıldı: borcun da alacağın da yok',
    'payment-paid': '{name} "{split}" içindeki {amount} tutarındaki ödemeyi ödendi olarak işaretledi',
    'delete-planned': '{name} "{split}" bölüşmesini siliyor — bir sahip durdurmazsa 7 gün sonra silinir',
    'delete-stopped': '"{split}" kalıyor: silme işlemi durduruldu',
    removed: '{name} seni "{split}" bölüşmesinden çıkardı',
    'made-owner': '{name} seni "{split}" bölüşmesinin sahibi yaptı',
  },
};

/** the kinds after which the receiver is not (or not yet) in the split: the tap lands on the list */
const SPLIT_OUTSIDE = new Set(['invited', 'refused', 'removed']);

/** settled is worded by the receiver's own figure: what they get, what they pay, or that they are even */
const settledKind = (cents: number): string => {
  if (cents > 0) return 'settled-get';
  return cents < 0 ? 'settled-pay' : 'settled-even';
};

function splitBody(payload: PushPayload, lang: string, someone: string): { body: string; url: string; tag: string } | null {
  const cents = payload.cents ?? 0;
  const kind = payload.kind === 'settled' ? settledKind(cents) : (payload.kind ?? '');
  const template = (SPLIT_TEXTS[lang] ?? SPLIT_TEXTS.en)[kind];
  if (!template) return null;
  const amount = `${(Math.abs(cents) / 100).toFixed(2)} ${payload.currency ?? ''}`.trim();
  const splitId = payload.splitId && /^[A-Za-z0-9._:-]+$/.test(payload.splitId) ? payload.splitId : undefined;
  return {
    body: template.replace('{name}', payload.fromName ?? someone).replace('{split}', payload.splitName ?? '').replace('{amount}', amount),
    url: splitId && !SPLIT_OUTSIDE.has(kind) ? `./#/splits/${splitId}` : './#/splits',
    tag: `split-${kind}-${splitId ?? ''}`,
  };
}

export interface WorkerNotification {
  title: string;
  body: string;
  /** coalescing tag */
  tag: string;
  /** click-through target (hash route) */
  url: string;
  /** new-transactions pushes also pre-sync the announced space */
  pullSpaceId?: string;
  pull: boolean;
}

/** a space id that may ride a url — anything else is dropped, never echoed into a route */
const spaceIdOf = (payload: PushPayload): string | undefined =>
  payload.spaceId && /^[A-Za-z0-9_-]+$/.test(payload.spaceId) ? payload.spaceId : undefined;

/** #551: the members of the space the event happened in, when the push names it */
const membersUrl = (payload: PushPayload): string => {
  const spaceId = spaceIdOf(payload);
  return spaceId ? `./#/spaces/${spaceId}/members` : './#/spaces';
};

function socialBody(payload: PushPayload, texts: PushTexts): { body: string; url: string; tag: string } | null {
  const name = payload.fromName ?? texts.someone;
  const space = payload.spaceName ?? texts.aSpace;
  switch (payload.type) {
    case 'friend-request':
      return { body: texts.friendRequest.replace('{name}', name), url: './#/friends', tag: 'friend-request' };
    case 'friend-accept':
      return { body: texts.friendAccept.replace('{name}', name), url: './#/friends', tag: 'friend-accept' };
    case 'space-invite':
      return { body: texts.spaceInvite.replace('{name}', name).replace('{space}', space), url: './#/spaces', tag: 'space-invite' };
    case 'space-join':
      return { body: texts.spaceJoin.replace('{name}', name).replace('{space}', space), url: membersUrl(payload), tag: 'space-join' };
    // #172/#173: membership changes reach the AFFECTED member's devices
    case 'member-removed':
      return { body: texts.memberRemoved.replace('{name}', name).replace('{space}', space), url: './#/spaces', tag: 'member-removed' };
    case 'member-role': {
      const role = texts.roles[payload.role ?? ''] ?? payload.role ?? '';
      return { body: texts.memberRole.replace('{space}', space).replace('{role}', role), url: membersUrl(payload), tag: 'member-role' };
    }
    default:
      return null;
  }
}

/** what (if anything) to show for a push payload, localized */
export function buildNotification(payload: PushPayload, lang: string): WorkerNotification | null {
  const texts = TEXTS[lang] ?? TEXTS.en;
  const spaceId = spaceIdOf(payload);
  // #551: a notification about one space wears its name as the title — the
  // social ones name their space in the sentence
  const spaceTitle = payload.spaceName?.trim() || texts.title;
  if (payload.type === 'new-transactions') {
    const count = payload.count ?? 1;
    return {
      title: spaceTitle,
      body: count === 1 ? texts.one : texts.many.replace('{n}', String(count)),
      tag: `new-tx-${spaceId ?? 'all'}`, // coalesce per space
      // #132 (user request): the tap lands IN the announced space's
      // review — the space rides the hash query for cold starts
      url: spaceId ? `./#/review?space=${spaceId}` : './#/review',
      pullSpaceId: spaceId,
      pull: true,
    };
  }
  if (payload.type === 'test') {
    // the proof that push reaches this device — the tap lands back on the space's notifications row
    return { title: spaceTitle, body: texts.test, tag: 'test', url: spaceId ? `./#/settings?space=${spaceId}` : './#/settings', pull: false };
  }
  const social = payload.type === 'split' ? splitBody(payload, lang, texts.someone) : socialBody(payload, texts);
  return social ? { title: texts.title, ...social, pull: false } : null;
}

/** the app language mirrored into the worker's kv store ('en' fallback) */
export function readWorkerLang(): Promise<string> {
  return new Promise((resolve) => {
    const open = indexedDB.open('munni_sw', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve('en');
    open.onsuccess = () => {
      try {
        const get = open.result.transaction('kv', 'readonly').objectStore('kv').get('lang');
        get.onsuccess = () => resolve(typeof get.result === 'string' ? get.result : 'en');
        get.onerror = () => resolve('en');
      } catch {
        resolve('en');
      }
    };
  });
}
