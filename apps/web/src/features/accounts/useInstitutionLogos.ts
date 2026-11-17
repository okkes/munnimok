import { config } from '@/app/config';
import { readSessionIdentity } from '@/app/session';
import type { AccountRow } from '@/db/types';
import { connectorApi } from '@/features/connectors/api';

/** the lookup field an open-banking party lists its institutions under (§15) — the logo route is keyed by it */
const INSTITUTION_FIELD = 'institution';

// #176/#414: the party vendors the logo as one immutable image the tag fetches itself, no credentials;
// 404s land in the <img> onError fallback
export function institutionLogoUrl(account: Pick<AccountRow, 'provider' | 'bankId'> | undefined): string | undefined {
  if (!account?.provider || !account.bankId || !config.apiUrl || readSessionIdentity()?.kind !== 'user') return undefined;
  return connectorApi.optionLogoUrl(account.provider, INSTITUTION_FIELD, account.bankId);
}
