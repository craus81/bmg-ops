/**
 * Order team chat (migration 357): one running conversation per estimate,
 * which is the same record once it becomes a sales order. Pure helpers,
 * shared by /api/order-chat and its tests.
 */

export interface OrderChatEstimate {
  id: string;
  estimate_number: string | null;
  title: string | null;
  customer_name: string | null;
  netsuite_so_number: string | null;
  netsuite_so_id?: string | null;
  status?: string | null;
  created_by: string | null;
  fleet_checkin_id?: string | null;
}

export interface OrderChatMember {
  user_id: string;
  following: boolean | null;
  last_read_at: string | null;
}

/** "SO #1234 · Acme Plumbing" once it's a sales order, else the estimate
 *  number. Used in the chat header, the Orders list and every ping. */
export function orderChatLabel(est: Pick<OrderChatEstimate, 'estimate_number' | 'netsuite_so_number' | 'netsuite_so_id' | 'customer_name'>): string {
  const so = est.netsuite_so_number || est.netsuite_so_id;
  const num = so ? `SO #${so}` : (est.estimate_number || 'Estimate');
  return est.customer_name ? `${num} · ${est.customer_name}` : num;
}

/** Is this person pinged on a new message? Followers are; the sales rep is
 *  too unless they tapped Unfollow. */
export function isFollowing(member: Pick<OrderChatMember, 'following'> | null | undefined, isRep: boolean): boolean {
  if (member?.following === true) return true;
  if (member?.following === false) return false;
  return isRep;
}

/**
 * Who gets the 'order_chat' ping for a new message: the rep and everyone
 * following, minus the poster, minus anyone @tagged in it (they get the
 * usual mention instead, so nobody is pinged twice for one message).
 */
export function orderChatRecipients(input: {
  members: Pick<OrderChatMember, 'user_id' | 'following'>[];
  repId: string | null;
  posterId: string;
  mentionedIds: Iterable<string>;
}): string[] {
  const { members, repId, posterId } = input;
  const mentioned = new Set(input.mentionedIds);
  const byUser = new Map(members.map(m => [m.user_id, m]));
  const out = new Set<string>();
  for (const m of members) {
    if (isFollowing(m, m.user_id === repId)) out.add(m.user_id);
  }
  if (repId && isFollowing(byUser.get(repId), true)) out.add(repId);
  out.delete(posterId);
  for (const id of mentioned) out.delete(id);
  return [...out];
}

/** Unread = messages from someone else after the person last read it. */
export function unreadCount(
  messages: { user_id: string | null; created_at: string }[],
  viewerId: string,
  lastReadAt: string | null,
): number {
  const since = lastReadAt ? Date.parse(lastReadAt) : -Infinity;
  return messages.filter(m => m.user_id !== viewerId && Date.parse(m.created_at) > since).length;
}
