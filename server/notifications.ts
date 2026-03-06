import { db } from './db';
import { pushTokens, notifications } from '../shared/schema';
import { inArray } from 'drizzle-orm';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

async function sendToExpo(messages: any[]) {
  const res = await fetch(EXPO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(messages),
  });
  return res.json();
}

export async function sendPushNotification({
  userIds, title, body, data = {},
}: {
  userIds: number[];
  title: string;
  body: string;
  data?: Record<string, any>;
}) {
  try {
    const tokens = await db.select().from(pushTokens).where(inArray(pushTokens.userId, userIds));
    if (!tokens.length) return;

    for (const uid of userIds) {
      await db.insert(notifications).values({ userId: uid, title, body, data: JSON.stringify(data) });
    }

    const messages = tokens
      .filter(t => t.token.startsWith('ExponentPushToken['))
      .map(t => ({ to: t.token, sound: 'default', title, body, data }));

    if (!messages.length) return;
    await sendToExpo(messages);
  } catch (e) {
    console.error('Push notification error:', e);
  }
}

export async function sendBroadcastNotification({
  title, body, data = {},
}: {
  title: string;
  body: string;
  data?: Record<string, any>;
}) {
  try {
    const tokens = await db.select().from(pushTokens);
    if (!tokens.length) return;

    await db.insert(notifications).values({ userId: null, title, body, data: JSON.stringify(data) });

    const messages = tokens
      .filter(t => t.token.startsWith('ExponentPushToken['))
      .map(t => ({ to: t.token, sound: 'default', title, body, data }));

    if (!messages.length) return;
    const result = await sendToExpo(messages);
    console.log('Broadcast result:', JSON.stringify(result));
  } catch (e) {
    console.error('Broadcast notification error:', e);
  }
}
