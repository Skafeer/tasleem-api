import { db } from './db';
import {
  referrals,
  referralRewards,
  processedReferralOrders,
  referralSettings,
  users,
  notifications,
} from '@shared/schema';
import { eq, sql } from 'drizzle-orm';
import { sendPushNotification } from './notifications';

// ══════════════════════════════════════════════════════════════════
// ── Settings Cache ──
// ══════════════════════════════════════════════════════════════════
let settingsCache: Record<string, string> | null = null;
let settingsCacheAt = 0;
const CACHE_TTL = 60_000; // دقيقة

export async function getReferralSettings(force = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!force && settingsCache && now - settingsCacheAt < CACHE_TTL) {
    return settingsCache;
  }
  const rows = await db.select().from(referralSettings);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  settingsCache = map;
  settingsCacheAt = now;
  return map;
}

export function clearReferralSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

export async function getReferralConfig() {
  const s = await getReferralSettings();
  return {
    enabled: s.referral_enabled === 'true',
    daysHold: Number(s.referral_days_hold || 7),
    threshold1: Number(s.referral_threshold_1 || 5),
    threshold2: Number(s.referral_threshold_2 || 20),
    threshold3: Number(s.referral_threshold_3 || 45),
    reward1: Number(s.referral_reward_1 || 5000),
    reward2: Number(s.referral_reward_2 || 20000),
    reward3: Number(s.referral_reward_3 || 35000),
    shareText: s.referral_share_text || '',
  };
}

// ══════════════════════════════════════════════════════════════════
// ── Validate referral code ──
// ══════════════════════════════════════════════════════════════════
export async function validateReferralCode(code: string): Promise<{
  valid: boolean;
  error?: string;
  referrer?: { id: number; storeName: string; merchantId: string };
}> {
  if (!code || !code.trim()) {
    return { valid: false, error: 'كود الإحالة مطلوب' };
  }
  const clean = code.trim().toUpperCase();
  if (!clean.startsWith('TSL')) {
    return { valid: false, error: 'كود الإحالة غير صحيح' };
  }

  const rows = await db.select().from(users).where(eq(users.merchantId, clean)).limit(1);
  if (!rows.length) {
    return { valid: false, error: 'كود الإحالة غير موجود' };
  }
  const referrer = rows[0];
  if (referrer.role !== 'merchant' && referrer.role !== 'admin') {
    return { valid: false, error: 'كود الإحالة غير صحيح' };
  }
  return {
    valid: true,
    referrer: { id: referrer.id, storeName: referrer.storeName, merchantId: referrer.merchantId },
  };
}

// ══════════════════════════════════════════════════════════════════
// ── Create referral ──
// ══════════════════════════════════════════════════════════════════
export async function createReferral(
  referrerId: number,
  refereeId: number,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  if (referrerId === refereeId) {
    return { ok: false, error: 'لا يمكن الإحالة الذاتية' };
  }
  try {
    const existing = await db.select().from(referrals).where(eq(referrals.refereeId, refereeId)).limit(1);
    if (existing.length) {
      return { ok: false, error: 'لديك إحالة مسجلة مسبقاً' };
    }
    await db.insert(referrals).values({
      referrerId,
      refereeId,
      code: code.trim().toUpperCase(),
    });
    return { ok: true };
  } catch (e: any) {
    console.error('createReferral error:', e);
    return { ok: false, error: 'حدث خطأ في تسجيل الإحالة' };
  }
}

// ══════════════════════════════════════════════════════════════════
// ── Process referral orders (Cron) ──
// ══════════════════════════════════════════════════════════════════
export async function processReferralOrders(): Promise<{
  processed: number;
  rewardsPaid: number;
  errors: number;
}> {
  const config = await getReferralConfig();
  if (!config.enabled) {
    console.log('⏸ Referral system disabled — skipping cron');
    return { processed: 0, rewardsPaid: 0, errors: 0 };
  }

  const cutoff = new Date(Date.now() - config.daysHold * 24 * 60 * 60 * 1000);
  let processed = 0;
  let rewardsPaid = 0;
  let errors = 0;

  // جلب الطلبات المؤهلة: delivered + deliveredAt <= cutoff + التاجر عنده إحالة
  const eligible = await db.execute(sql`
    SELECT o.id AS order_id, o.merchant_id AS referee_id, r.id AS referral_id, r.referrer_id
    FROM orders o
    INNER JOIN referrals r ON r.referee_id = o.merchant_id
    LEFT JOIN processed_referral_orders p ON p.order_id = o.id
    WHERE o.status = 'delivered'
      AND o.delivered_at IS NOT NULL
      AND o.delivered_at <= ${cutoff.toISOString()}
      AND p.id IS NULL
    ORDER BY o.delivered_at ASC
    LIMIT 500
  `);

  const rows = ((eligible as any).rows || []) as any[];

  for (const row of rows) {
    // ✅ مصفوفة بدل متغير واحد — تدعم أكثر من مكافأة بنفس الطلب
    const paidRewards: { referrerId: number; amount: number; stage: number; refereeId: number }[] = [];

    try {
      await db.transaction(async (tx) => {
        // 1. منع التزامن — تحقق مزدوج داخل transaction
        const dup = await tx.execute(sql`
          SELECT id FROM processed_referral_orders WHERE order_id = ${row.order_id} LIMIT 1
        `);
        if (((dup as any).rows || []).length > 0) return;

        // 2. سجل الطلب كمعالج
        await tx.insert(processedReferralOrders).values({
          orderId: Number(row.order_id),
          refereeId: Number(row.referee_id),
          referralId: Number(row.referral_id),
        });

        // 3. زيادة العداد
        const updated = await tx.execute(sql`
          UPDATE referrals
          SET delivered_orders_count = delivered_orders_count + 1
          WHERE id = ${row.referral_id}
          RETURNING delivered_orders_count, referrer_id, referee_id,
                    reward1_paid, reward2_paid, reward3_paid
        `);
        const referralRow = ((updated as any).rows || [])[0];
        if (!referralRow) return;

        const count = Number(referralRow.delivered_orders_count);
        const referrerId = Number(referralRow.referrer_id);
        const refereeId = Number(referralRow.referee_id);

        // 4. التحقق من العتبات
        const stages: { stage: number; threshold: number; reward: number; paidKey: string; atKey: string }[] = [
          { stage: 1, threshold: config.threshold1, reward: config.reward1, paidKey: 'reward1_paid', atKey: 'reward1_at' },
          { stage: 2, threshold: config.threshold2, reward: config.reward2, paidKey: 'reward2_paid', atKey: 'reward2_at' },
          { stage: 3, threshold: config.threshold3, reward: config.reward3, paidKey: 'reward3_paid', atKey: 'reward3_at' },
        ];

        for (const s of stages) {
          const isPaid = Boolean((referralRow as any)[s.paidKey]);
          if (count >= s.threshold && !isPaid) {
            // سجل المكافأة
            await tx.insert(referralRewards).values({
              referralId: Number(row.referral_id),
              referrerId,
              refereeId,
              stage: s.stage,
              amount: s.reward,
              ordersAtPayout: count,
              status: 'paid',
            });

            // حدّث referrals
            await tx.execute(sql`
              UPDATE referrals
              SET ${sql.raw(s.paidKey)} = TRUE,
                  ${sql.raw(s.atKey)} = NOW(),
                  total_reward_paid = total_reward_paid + ${s.reward}
              WHERE id = ${row.referral_id}
            `);

            // أضف الرصيد للداعي
            await tx.execute(sql`
              UPDATE users SET balance = balance + ${s.reward} WHERE id = ${referrerId}
            `);

            // إشعار داخل التطبيق (جدول notifications)
            await tx.insert(notifications).values({
              userId: referrerId,
              title: '💰 مكافأة إحالة جديدة',
              body: `ربحت ${s.reward.toLocaleString()} د.ع من إحالة (المرحلة ${s.stage})`,
              data: JSON.stringify({ type: 'referral_reward', stage: s.stage, amount: s.reward, refereeId }),
            });

            // نحتفظ بالمكافأة لدفعة الـ push (خارج transaction)
            paidRewards.push({ referrerId, amount: s.reward, stage: s.stage, refereeId });
            rewardsPaid++;
          }
        }
      });
      processed++;

      // 5. إشعارات push خارج الـ transaction (بعد النجاح فقط)
      for (const paid of paidRewards) {
        try {
          // جلب اسم المتجر للمدعو للإشعار
          const refereeRows = await db.execute(sql`
            SELECT store_name FROM users WHERE id = ${paid.refereeId} LIMIT 1
          `);
          const refereeStore = ((refereeRows as any).rows || [])[0]?.store_name || 'تاجر جديد';

          await sendPushNotification({
            userIds: [paid.referrerId],
            title: '💰 مكافأة إحالة جديدة',
            body: `ربحت ${paid.amount.toLocaleString()} د.ع من إحالة ${refereeStore} (المرحلة ${paid.stage})`,
            data: { type: 'referral_reward', stage: paid.stage, amount: paid.amount },
          });
        } catch (pushErr) {
          console.error('Referral push error:', pushErr);
        }
      }
    } catch (e: any) {
      console.error(`❌ referral process error for order ${row.order_id}:`, e);
      errors++;
    }
  }

  console.log(`✅ Referral cron: processed=${processed}, rewards=${rewardsPaid}, errors=${errors}`);
  return { processed, rewardsPaid, errors };
}

// ══════════════════════════════════════════════════════════════════
// ── Get referral data for merchant ──
// ══════════════════════════════════════════════════════════════════
export async function getMerchantReferralData(merchantId: number) {
  const config = await getReferralConfig();
  const userRows = await db.select().from(users).where(eq(users.id, merchantId)).limit(1);
  if (!userRows.length) return null;
  const user = userRows[0];

  const refs = await db.execute(sql`
    SELECT r.id, r.referee_id, r.delivered_orders_count,
           r.reward1_paid, r.reward2_paid, r.reward3_paid,
           r.total_reward_paid, r.created_at,
           u.store_name, u.merchant_id
    FROM referrals r
    INNER JOIN users u ON u.id = r.referee_id
    WHERE r.referrer_id = ${merchantId}
    ORDER BY r.created_at DESC
  `);
  const referees = ((refs as any).rows || []) as any[];

  const totalReferrals = referees.length;
  const totalRewardPaid = referees.reduce((sum, r) => sum + Number(r.total_reward_paid || 0), 0);
  const activeReferrals = referees.filter((r) => Number(r.delivered_orders_count) > 0).length;

  return {
    code: user.merchantId,
    shareText: config.shareText.replace('{CODE}', user.merchantId),
    config: {
      threshold1: config.threshold1,
      threshold2: config.threshold2,
      threshold3: config.threshold3,
      reward1: config.reward1,
      reward2: config.reward2,
      reward3: config.reward3,
      daysHold: config.daysHold,
    },
    stats: { totalReferrals, totalRewardPaid, activeReferrals },
    referees: referees.map((r) => {
      const count = Number(r.delivered_orders_count);
      const stage1Done = Boolean(r.reward1_paid);
      const stage2Done = Boolean(r.reward2_paid);
      const stage3Done = Boolean(r.reward3_paid);
      let nextThreshold = config.threshold1;
      if (stage1Done) nextThreshold = config.threshold2;
      if (stage2Done) nextThreshold = config.threshold3;
      if (stage3Done) nextThreshold = config.threshold3;
      return {
        storeName: r.store_name,
        merchantId: r.merchant_id,
        joinedAt: r.created_at,
        deliveredOrdersCount: count,
        rewardPaid: Number(r.total_reward_paid || 0),
        stages: {
          s1: { done: stage1Done, threshold: config.threshold1, reward: config.reward1 },
          s2: { done: stage2Done, threshold: config.threshold2, reward: config.reward2 },
          s3: { done: stage3Done, threshold: config.threshold3, reward: config.reward3 },
        },
        nextThreshold,
        remainingToNext: Math.max(0, nextThreshold - count),
      };
    }),
  };
}