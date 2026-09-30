// server/campaigns.ts
import { db } from "./db";
import { storage } from "./storage";
import {
  campaigns, campaignParticipants, campaignOrders, campaignRewards,
  promoCodes,
} from "@shared/schema";
import { eq, sql, and, lte, gte } from "drizzle-orm";

// ══════════════════════════════════════════════════════════════════
// ── عند تسليم طلب: احتساب فوري في الحملات ──
// ✅ يتحقق من أن التسليم الفعلي كان داخل فترة الحملة
// ✅ يدعم إعادة الاحتساب عند الرجوع من rejected → counted
// ══════════════════════════════════════════════════════════════════
export async function countOrderInCampaigns(orderId: number) {
  try {
    const order = await storage.getOrder(orderId);
    if (!order || order.status !== 'delivered') return;

    const orderProductIds = (order.items || []).map((i: any) => i.productId);
    if (orderProductIds.length === 0) return;

    // ✅ وقت التسليم الفعلي (يُستخدم للتحقق من نطاق الحملة)
    const deliveredAt = order.deliveredAt ? new Date(order.deliveredAt) : new Date();

    const now = new Date();

    // الحملات النشطة الحالية
    const activeCampaigns = await db.select().from(campaigns).where(
      and(
        eq(campaigns.isActive, true),
        lte(campaigns.startsAt, now),
        gte(campaigns.endsAt, now)
      )
    );

    const relevant = activeCampaigns.filter((c: any) =>
      orderProductIds.includes(c.productId)
    );

    for (const campaign of relevant) {
      // ✅ تحقق: هل الطلب سُلِّم فعلاً خلال فترة الحملة؟
      const campaignStart = new Date(campaign.startsAt);
      const campaignEnd = new Date(campaign.endsAt);

      if (deliveredAt < campaignStart || deliveredAt > campaignEnd) {
        continue; // تسليم خارج نطاق الحملة → تجاهل
      }

      // موجود مسبقاً؟
      const existing = await db.select().from(campaignOrders).where(
        and(
          eq(campaignOrders.campaignId, campaign.id),
          eq(campaignOrders.orderId, orderId)
        )
      ).limit(1);

      // ✅ محتسب مسبقاً → تجاهل
      if (existing.length > 0 && existing[0].status === 'counted') continue;

      // ✅ كان مرفوضاً → أعِد تفعيله
      if (existing.length > 0 && existing[0].status === 'rejected') {
        await db.update(campaignOrders)
          .set({ status: 'counted', countedAt: now })
          .where(eq(campaignOrders.id, existing[0].id));
      } else {
        // ✅ سجل جديد
        await db.insert(campaignOrders).values({
          campaignId: campaign.id,
          userId: order.merchantId,
          orderId,
          status: 'counted',
          deliveredAt,
          countedAt: now,
        });
      }

      // ابحث عن المشارك أو أنشئه
      let participant = (await db.select().from(campaignParticipants).where(
        and(
          eq(campaignParticipants.campaignId, campaign.id),
          eq(campaignParticipants.userId, order.merchantId)
        )
      ).limit(1))[0];

      if (!participant) {
        const inserted = await db.insert(campaignParticipants).values({
          campaignId: campaign.id,
          userId: order.merchantId,
          progressCount: 0,
        }).returning();
        participant = inserted[0];
      }

      // زيادة العدّاد
      await db.execute(sql`
        UPDATE campaign_participants
        SET progress_count = progress_count + 1
        WHERE id = ${participant.id}
      `);

      // تحقق من الوصول للهدف
      const newCount = (participant.progressCount || 0) + 1;

      if (newCount >= campaign.targetCount && !participant.targetReached) {
        await db.update(campaignParticipants).set({
          targetReached: true,
          targetReachedAt: now,
        }).where(eq(campaignParticipants.id, participant.id));

        try {
          const { sendPushNotification } = await import('./notifications');
          await sendPushNotification({
            userIds: [order.merchantId],
            title: '🎯 وصلت للهدف!',
            body: `أكملت تحدي "${campaign.title}" — المكافأة ستُصرف بعد انتهاء الحملة`,
            data: { type: 'campaign_target_reached', campaignId: String(campaign.id) },
          });
        } catch (_) {}
      }
    }
  } catch (e) {
    console.error('countOrderInCampaigns error:', e);
  }
}

// ══════════════════════════════════════════════════════════════════
// ── عند إلغاء/رفض طلب: إنقاص العدّاد ──
// ══════════════════════════════════════════════════════════════════
export async function rejectOrderInCampaigns(orderId: number) {
  try {
    const entries = await db.select().from(campaignOrders)
      .where(eq(campaignOrders.orderId, orderId));

    for (const entry of entries) {
      if (entry.status === 'rejected') continue;

      // لو كان counted → إنقاص العدّاد
      if (entry.status === 'counted') {
        await db.execute(sql`
          UPDATE campaign_participants
          SET progress_count = GREATEST(0, progress_count - 1)
          WHERE campaign_id = ${entry.campaignId} AND user_id = ${entry.userId}
        `);

        // إذا نزل تحت الهدف، ألغِ targetReached
        await db.execute(sql`
          UPDATE campaign_participants
          SET target_reached = FALSE, target_reached_at = NULL
          WHERE campaign_id = ${entry.campaignId}
            AND user_id = ${entry.userId}
            AND progress_count < (SELECT target_count FROM campaigns WHERE id = ${entry.campaignId})
        `);
      }

      await db.update(campaignOrders)
        .set({ status: 'rejected' })
        .where(eq(campaignOrders.id, entry.id));
    }
  } catch (e) {
    console.error('rejectOrderInCampaigns error:', e);
  }
}

// ══════════════════════════════════════════════════════════════════
// ── توزيع مكافآت الحملات المنتهية ──
// ══════════════════════════════════════════════════════════════════
export async function distributeCampaignRewards() {
  try {
    const now = new Date();

    const expiredCampaigns = await db.select().from(campaigns).where(
      and(
        eq(campaigns.isActive, true),
        eq(campaigns.isDistributed, false),
        lte(campaigns.endsAt, now)
      )
    );

    for (const campaign of expiredCampaigns) {
      const winners = await db.select().from(campaignParticipants).where(
        and(
          eq(campaignParticipants.campaignId, campaign.id),
          eq(campaignParticipants.targetReached, true),
          eq(campaignParticipants.rewardClaimed, false)
        )
      );

      for (const participant of winners) {
        try {
          await grantReward(campaign, participant);
          await db.update(campaignParticipants).set({
            rewardClaimed: true,
            rewardClaimedAt: now,
          }).where(eq(campaignParticipants.id, participant.id));
        } catch (err) {
          console.error(`Reward grant failed for participant ${participant.id}:`, err);
        }
      }

      await db.update(campaigns).set({
        isDistributed: true,
        distributedAt: now,
      }).where(eq(campaigns.id, campaign.id));

      console.log(`✅ Campaign "${campaign.title}" distributed to ${winners.length} winner(s)`);
    }
  } catch (e) {
    console.error('distributeCampaignRewards error:', e);
  }
}

// ══════════════════════════════════════════════════════════════════
// ── منح مكافأة ──
// ══════════════════════════════════════════════════════════════════
async function grantReward(campaign: any, participant: any) {
  const rewardData = JSON.parse(campaign.rewardData || '{}');
  const now = new Date();

  // ═══ 1. كاش باك ═══
  if (campaign.rewardType === 'cashback') {
    const amount = Number(campaign.rewardValue) || 0;
    if (amount > 0) {
      await db.execute(sql`
        UPDATE users SET balance = balance + ${amount}
        WHERE id = ${participant.userId}
      `);

      await db.insert(campaignRewards).values({
        campaignId: campaign.id,
        userId: participant.userId,
        rewardType: 'cashback',
        cashAmount: amount,
      });

      try {
        const { sendPushNotification } = await import('./notifications');
        await sendPushNotification({
          userIds: [participant.userId],
          title: '🎁 مكافأة كاش باك!',
          body: `تم إضافة ${amount.toLocaleString()} د.ع لرصيدك من تحدي "${campaign.title}"`,
          data: { type: 'campaign_reward', campaignId: String(campaign.id) },
        });
      } catch (_) {}
    }
    return;
  }

  // ═══ 2, 3, 4. الأكواد (توصيل / منتج / شحن مجاني) ═══
  const {
    codePrefix = 'GIFT',
    expiresInDays = 30,
    maxDiscount = 0,
  } = rewardData;

  const code = `${codePrefix}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

  let appliesTo: 'subtotal' | 'shipping' = 'shipping';
  let discountPercent = 100;

  if (campaign.rewardType === 'shipping_code') {
    appliesTo = 'shipping';
    discountPercent = Number(campaign.rewardValue) || 50;
  } else if (campaign.rewardType === 'free_shipping') {
    appliesTo = 'shipping';
    discountPercent = 100;
  } else if (campaign.rewardType === 'product_code') {
    appliesTo = 'subtotal';
    discountPercent = Number(campaign.rewardValue) || 10;
  }

  // ── إنشاء promo_code ──
  await db.insert(promoCodes).values({
    code,
    title: `مكافأة تحدي: ${campaign.title}`,
    description: `مكافأة تلقائية من إكمال التحدي`,
    discountType: 'percentage',
    discountPercent,
    discountAmount: 0,
    maxDiscount: maxDiscount || 0,
    appliesTo,
    targetType: 'specific',
    targetUserIds: String(participant.userId),
    minCartAmount: 0,
    startsAt: now,
    expiresAt,
    maxUses: 1,
    maxUsesPerUser: 1,
    isActive: true,
  } as any);

  // ── سجل المكافأة ──
  await db.insert(campaignRewards).values({
    campaignId: campaign.id,
    userId: participant.userId,
    rewardType: campaign.rewardType,
    code,
    value: campaign.rewardValue,
    appliesTo,
    expiresAt,
  });

  // ── إشعار ──
  try {
    const { sendPushNotification } = await import('./notifications');
    const labels: any = {
      shipping_code: 'كود خصم توصيل',
      free_shipping: 'شحن مجاني',
      product_code: 'كود خصم منتج',
    };
    await sendPushNotification({
      userIds: [participant.userId],
      title: `🎁 ${labels[campaign.rewardType] || 'مكافأة'}!`,
      body: `كودك: ${code} — صالح حتى ${expiresAt.toLocaleDateString('ar-IQ')}`,
      data: { type: 'campaign_reward', campaignId: String(campaign.id), code },
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════
// ── Cron: توزيع مكافآت الحملات المنتهية (كل ساعة) ──
// ══════════════════════════════════════════════════════════════════
export function startCampaignCron() {
  setInterval(async () => {
    try {
      await distributeCampaignRewards();
    } catch (e) {
      console.error('Campaign cron error:', e);
    }
  }, 60 * 60 * 1000);

  // أول تشغيل بعد 5 ثوانٍ من الإقلاع
  setTimeout(async () => {
    try {
      await distributeCampaignRewards();
      console.log('✅ Campaign cron initial run done');
    } catch (e) {
      console.error('Campaign cron initial run error:', e);
    }
  }, 5000);
}
