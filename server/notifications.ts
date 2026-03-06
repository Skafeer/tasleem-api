import Expo, { ExpoPushMessage } from 'expo-server-sdk';
import { db } from './db';
import { pushTokens, notifications } from '../shared/schema';
import { eq, inArray } from 'drizzle-orm';

const expo = new Expo();
const { isExpoPushToken } = Expo;

// إرسال إشعار لمستخدم واحد أو مجموعة
export async function sendPushNotification({
  userIds,
  title,
  body,
  data = {},
}: {
  userIds: number[];
  title: string;
  body: string;
  data?: Record<string, any>;
}) {
  try {
    // جلب tokens المستخدمين
    const tokens = await db
      .select()
      .from(pushTokens)
      .where(inArray(pushTokens.userId, userIds));

    if (!tokens.length) return;

    // حفظ الإشعار في قاعدة البيانات
    for (const uid of userIds) {
      await db.insert(notifications).values({
        userId: uid,
        title,
        body,
        data: JSON.stringify(data),
      });
    }

    // إرسال الإشعارات
    const messages: ExpoPushMessage[] = tokens
      .filter(t => isExpoPushToken(t.token))
      .map(t => ({
        to:    t.token,
        sound: 'default' as const,
        title,
        body,
        data,
      }));

    if (!messages.length) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (e) {
    console.error('Push notification error:', e);
  }
}

// إرسال إشعار لجميع المستخدمين
export async function sendBroadcastNotification({
  title,
  body,
  data = {},
}: {
  title: string;
  body: string;
  data?: Record<string, any>;
}) {
  try {
    const tokens = await db.select().from(pushTokens);
    if (!tokens.length) return;

    // حفظ إشعار عام (userId = null)
    await db.insert(notifications).values({ userId: null, title, body, data: JSON.stringify(data) });

    const messages: ExpoPushMessage[] = tokens
      .filter(t => isExpoPushToken(t.token))
      .map(t => ({ to: t.token, sound: 'default' as const, title, body, data }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (e) {
    console.error('Broadcast notification error:', e);
  }
}
