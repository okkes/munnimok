import { apiFetch } from '@/lib/api';

export type FriendRequestOutcome = 'sent' | 'notFound' | 'failed';

/** #291: one sender for both request surfaces; the server's 404 (id points at nobody) becomes a field error */
export async function postFriendRequest(body: {
  toUserId: string;
  spaceId?: string;
  role?: string;
  spaceName?: string;
}): Promise<FriendRequestOutcome> {
  const res = await apiFetch('/friends/requests', { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
  if (res?.ok) return 'sent';
  // ToUserId is a Guid server-side, so a malformed id gets 400/422 before the 404; the user can't act differently on it,
  // so both get the same field error
  return res && [400, 404, 422].includes(res.status) ? 'notFound' : 'failed';
}
