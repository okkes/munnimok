import { visibleAccounts, visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountType } from '@/db/types';
import { kindOf } from '@/domain/txKind';
import { autoSubFor, stampMovementSub } from '@/domain/categories';
import { accountStamp, familyForCounter, movementCatFor } from '@/domain/txType';
import { matchTransferPairs } from '@/domain/transferMatch';
import type { TransferLeg } from '@/domain/transferMatch';

// within each space's own books only: spaces never reference each other's transactions (cross-space is the funding type)
// idempotent, conservative: peered rows never re-enter, ambiguity leaves both legs alone
// pass 2: an out-leg's deliberate linkedAccountId may claim that account's raw income twin and type it as the mirror
export async function linkTransferPairs(store: StorageBackend, repo: Repo): Promise<number> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  let linked = 0;
  for (const space of spaces) {
    linked += await linkSpacePairs(store, repo, space.id);
  }
  return linked;
}

async function linkSpacePairs(store: StorageBackend, repo: Repo, spaceId: string): Promise<number> {
  const all = await visibleTransactions(store, spaceId);
  const byId = new Map(all.map((tx) => [tx.id, tx]));
  // #536: an account's type is the space's reading (an attachment's); a global account carries none
  const types = new Map((await visibleAccounts(store, spaceId)).map((a) => [a.id, a.type]));
  const typeOf: TypeOf = (accountId) => types.get(accountId);
  const asLeg = (tx: SpaceTx): TransferLeg => ({
    id: tx.id,
    accountId: tx.accountId,
    amountCents: tx.amountCents,
    date: tx.date,
    linkedAccountId: tx.linkedAccountId,
    transferPeerId: tx.transferPeerId,
  });

  // the pool: rows whose derived type is transfer-family (funding is a special category, kindOf keeps it out)
  const typed = all.filter((tx) => kindOf(tx.txType) === 'transfer');
  const pairs = matchTransferPairs(typed.map(asLeg));
  let linked = 0;
  for (const [outId, incId] of pairs) {
    await writePair(typeOf, repo, byId.get(outId), byId.get(incId), {});
    linked++;
  }

  const paired = new Set<string>([...pairs.keys(), ...pairs.values()]);
  const rawIncomes = all.filter((tx) => tx.amountCents > 0 && tx.txType === 'income' && !tx.linkedAccountId && !tx.transferPeerId && !paired.has(tx.id));
  const openOuts = typed.filter((tx) => tx.amountCents < 0 && !!tx.linkedAccountId && !tx.transferPeerId && !paired.has(tx.id));
  for (const out of openOuts) {
    const twins = rawIncomes.filter(
      (inc) =>
        !paired.has(inc.id) &&
        inc.accountId === out.linkedAccountId &&
        inc.amountCents === Math.abs(out.amountCents) &&
        Math.abs(Date.parse(inc.date) - Date.parse(out.date)) <= 2 * 86_400_000,
    );
    if (twins.length !== 1) continue; // none, or ambiguous — a human's call
    const twin = twins[0];
    paired.add(out.id);
    paired.add(twin.id);
    // the twin becomes the typed mirror: its account's stamp + forced movement sub, else its counter's kind (#133 r5)
    // its review flag stays: this is machine pairing on boot/import, the person confirms it in the deck
    const stamp = accountStamp(typeOf(twin.accountId));
    const outType = typeOf(out.accountId);
    await writePair(typeOf, repo, out, twin, {
      linkedAccountId: out.accountId,
      catId:
        (stamp ? stampMovementSub(stamp, twin.amountCents) : undefined) ??
        (outType ? movementCatFor(outType, twin.amountCents) : autoSubFor('transfer', twin.amountCents)),
    });
    linked++;
  }
  return linked;
}

type TypeOf = (accountId: string) => AccountType | undefined;

async function writePair(typeOf: TypeOf, repo: Repo, out: SpaceTx | undefined, inc: SpaceTx | undefined, incExtra: Parameters<typeof writeTxTransform>[2]): Promise<void> {
  if (!out || !inc) return;
  // a null counterparty auto-fills from the other leg; a stamped leg stores its stamp + forced movement sub (Q8)
  // an unstamped leg whose counter is a special account files its movement sub: checking↔savings reads Set aside (#133 r5)
  // the peer in the same write keeps the choke point from minting; review flags stay put (machine pairing, person confirms)
  const enrich = (leg: SpaceTx, other: SpaceTx): Parameters<typeof writeTxTransform>[2] => {
    const stamp = accountStamp(typeOf(leg.accountId));
    if (stamp) {
      return {
        ...(leg.linkedAccountId ? {} : { linkedAccountId: other.accountId }),
        catId: stampMovementSub(stamp, leg.amountCents),
      };
    }
    const counterType = typeOf(other.accountId);
    const family = counterType ? familyForCounter(counterType) : 'transfer';
    return {
      ...(leg.linkedAccountId ? {} : { linkedAccountId: other.accountId }),
      ...(family !== 'transfer' && counterType ? { catId: movementCatFor(counterType, leg.amountCents) } : {}),
    };
  };
  await writeTxTransform(repo, out, { ...enrich(out, inc), transferPeerId: inc.id });
  await writeTxTransform(repo, inc, { ...enrich(inc, out), ...incExtra, transferPeerId: out.id });
}

// the mirror leg is minted by the writeTxTransform choke point when a manual counter account is linked (mirrorMint.ts)
