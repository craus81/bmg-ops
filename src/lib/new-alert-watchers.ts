/**
 * "Copy me on new alerts" (notification_preferences.copy_new_alerts, #1335):
 * Craig, while he watches how new alerts work, hears every one too.
 */

/** Everyone ticked "Copy me on new alerts" (Craig, for now). */
export async function newAlertWatcherIds(service: { from: (table: string) => any }): Promise<string[]> {
  const { data } = await service
    .from('notification_preferences')
    .select('user_id')
    .eq('copy_new_alerts', true);
  return [...new Set(((data || []) as any[]).map(r => r.user_id as string).filter(Boolean))];
}
