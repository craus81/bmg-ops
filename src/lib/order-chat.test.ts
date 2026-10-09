import { describe, it, expect } from 'vitest';
import { orderChatLabel, orderChatRecipients, isFollowing, unreadCount } from './order-chat';

describe('orderChatLabel', () => {
  it('names the SO once there is one, else the estimate', () => {
    expect(orderChatLabel({ estimate_number: 'EST-100', netsuite_so_number: '5521', customer_name: 'Acme' })).toBe('SO #5521 · Acme');
    expect(orderChatLabel({ estimate_number: 'EST-100', netsuite_so_number: null, customer_name: 'Acme' })).toBe('EST-100 · Acme');
    expect(orderChatLabel({ estimate_number: 'EST-100', netsuite_so_number: null, customer_name: null })).toBe('EST-100');
  });
});

describe('isFollowing', () => {
  it('follows the rep by default, and anyone who chose to', () => {
    expect(isFollowing(null, true)).toBe(true);
    expect(isFollowing({ following: null }, true)).toBe(true);
    expect(isFollowing({ following: false }, true)).toBe(false);
    expect(isFollowing({ following: null }, false)).toBe(false);
    expect(isFollowing({ following: true }, false)).toBe(true);
  });
});

describe('orderChatRecipients', () => {
  it('pings the rep and followers, never the poster', () => {
    const r = orderChatRecipients({
      members: [
        { user_id: 'a', following: true },
        { user_id: 'b', following: null },
        { user_id: 'c', following: false },
        { user_id: 'poster', following: true },
      ],
      repId: 'rep',
      posterId: 'poster',
      mentionedIds: [],
    });
    expect(r.sort()).toEqual(['a', 'rep']);
  });

  it('leaves out a rep who unfollowed', () => {
    const r = orderChatRecipients({
      members: [{ user_id: 'rep', following: false }, { user_id: 'a', following: true }],
      repId: 'rep', posterId: 'x', mentionedIds: [],
    });
    expect(r).toEqual(['a']);
  });

  it('skips @tagged people, who get the mention instead', () => {
    const r = orderChatRecipients({
      members: [{ user_id: 'a', following: true }, { user_id: 'b', following: true }],
      repId: null, posterId: 'x', mentionedIds: ['b'],
    });
    expect(r).toEqual(['a']);
  });

  it('does not ping a rep who is the one posting', () => {
    const r = orderChatRecipients({ members: [], repId: 'rep', posterId: 'rep', mentionedIds: [] });
    expect(r).toEqual([]);
  });
});

describe('unreadCount', () => {
  const msgs = [
    { user_id: 'me', created_at: '2026-10-09T10:00:00Z' },
    { user_id: 'x', created_at: '2026-10-09T10:05:00Z' },
    { user_id: 'y', created_at: '2026-10-09T10:10:00Z' },
  ];
  it('counts other people\'s messages since last read', () => {
    expect(unreadCount(msgs, 'me', null)).toBe(2);
    expect(unreadCount(msgs, 'me', '2026-10-09T10:06:00Z')).toBe(1);
    expect(unreadCount(msgs, 'me', '2026-10-09T10:10:00Z')).toBe(0);
  });
});
