import * as admin from 'firebase-admin';
import { db } from './db';
import { pushTokens, notifications } from '../shared/schema';
import { inArray } from 'drizzle-orm';

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT!, 'base64').toString('utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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
      } catch (e: any) {
        console.error('Token send error:', e.message);
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
        console.log('Sent:', result);
      } catch (e: any) {
        console.error('Token error:', e.message);
      }
    }
  } catch (e) {
    console.error('Broadcast notification error:', e);
  }
}
