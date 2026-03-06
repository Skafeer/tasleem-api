import * as admin from 'firebase-admin';
import { db } from './db';
import { pushTokens, notifications } from '../shared/schema';
import { inArray } from 'drizzle-orm';
import * as path from 'path';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      path.join(__dirname, 'tasleem-472de-firebase-adminsdk-fbsvc-dd6d05e853.json')
    ),
  });
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

    for (const t of tokens) {
      try {
        await admin.messaging().send({
          token: t.token,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
        });
      } catch (e) {
        console.error('Token send error:', e);
      }
    }
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
    if (!tokens.length) { console.log('No tokens found'); return; }

    await db.insert(notifications).values({ userId: null, title, body, data: JSON.stringify(data) });

    for (const t of tokens) {
      try {
        const result = await admin.messaging().send({
          token: t.token,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
        });
        console.log('Sent to:', t.token.slice(0,20), 'result:', result);
      } catch (e: any) {
        console.error('Token error:', t.token.slice(0,20), e.message);
      }
    }
  } catch (e) {
    console.error('Broadcast notification error:', e);
  }
}
