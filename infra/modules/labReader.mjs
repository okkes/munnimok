import { localAwareFetch } from './insecure-fetch.mjs';
import { LAB_READER_ITEM, labReaderToken } from './logto.mjs';
import { vaultReadFolder } from './vault.mjs';

// the lab's reader (#635) from the outside: its account is in the environment's vault folder and nowhere else

/** the account as the environment's bootstrap filed it; null when the folder holds none yet */
export async function labReaderAccount(shared, stack, { email, password }, fetchImpl = localAwareFetch) {
  const items = await vaultReadFolder(shared.urls.vault, { email, password, folder: stack.stack }, fetchImpl);
  const item = items.find((i) => i.name === LAB_READER_ITEM);
  return item?.username && item.password ? { appId: item.username, secret: item.password } : null;
}

/** one token, then a reader of the api's paths; an answer is its status, type and bytes — never a thrown refusal */
export async function openLab(stack, account, fetchImpl = localAwareFetch) {
  const token = await labReaderToken(stack, account, fetchImpl);
  return async (path) => {
    const res = await fetchImpl(`${stack.urls.api}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
  };
}

/** `provider=bol kind=login` → `?provider=bol&kind=login` */
export function labQuery(pairs) {
  const query = new URLSearchParams();
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`"${pair}" is not key=value`);
    query.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}
