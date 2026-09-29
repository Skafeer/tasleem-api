import { db } from "./db";
import {
  users, products, orders, orderItems, withdrawals, favorites,
  promoCodes, promoUsages,
  campaigns, campaignParticipants, campaignOrders, campaignRewards,
} from "@shared/schema";
import { eq, and, sql, desc, inArray, gte, lte } from "drizzle-orm";

export const storage = {
  // ── Users ──
  async getUser(id: number) {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  },
  async getUserByPhone(phone: string) {
    const result = await db.select().from(users).where(eq(users.phone, phone));
    return result[0];
  },
  async createUser(data: any) {
    const result = await db.insert(users).values(data).returning();
    return result[0];
  },
  async updateUser(id: number, data: any) {
    const ALLOWED: (keyof typeof data)[] = [
      'storeName', 'phone', 'address', 'password',
      'balance', 'pendingBalance', 'role', 'isActive', 'permissions',
      'isSuperAdmin', 'is_super_admin', 'merchantId',
      'pushToken', 'supportBlocked',
    ];
    const safe: any = {};
    for (const key of ALLOWED) {
      if (key in data) safe[key] = data[key];
    }
    if (Object.keys(safe).length === 0) return storage.getUser(id);
    const result = await db.update(users).set(safe).where(eq(users.id, id)).returning();
    return result[0];
  },
  async getAllUsers() {
    const all = await db.select().from(users);
    return all.map(({ password, ...safe }: any) => safe);
  },
  async deleteUser(id: number) {
    await db.delete(users).where(eq(users.id, id));
  },

  // ── Products ──
  async getProducts() {
    return db.select().from(products);
  },
  async getProduct(id: number) {
    const result = await db.select().from(products).where(eq(products.id, id));
    return result[0];
  },
  async createProduct(data: any) {
    const result = await db.insert(products).values(data).returning();
    return result[0];
  },
  async updateProduct(id: number, data: any) {
    const result = await db.update(products).set(data).where(eq(products.id, id)).returning();
    return result[0];
  },
  async deleteProduct(id: number) {
    await db.delete(products).where(eq(products.id, id));
  },

  // ── Orders ──
  async getOrders(merchantId?: number) {
    const allOrders = merchantId
      ? await db.select().from(orders).where(eq(orders.merchantId, merchantId))
      : await db.select().from(orders);

    const result = await Promise.all(allOrders.map(async (order) => {
      const items = await db.select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        productId: orderItems.productId,
        quantity: orderItems.quantity,
        price: orderItems.price,
        cost: orderItems.cost,
        product: products,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(eq(orderItems.orderId, order.id));
      return { ...order, items };
    }));

    return result.sort((a, b) =>
      new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()
    );
  },

  async getOrder(id: number) {
    const result = await db.select().from(orders).where(eq(orders.id, id));
    if (!result[0]) return null;
    const order = result[0];

    const items = await db.select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      price: orderItems.price,
      cost: orderItems.cost,
      product: products,
    })
    .from(orderItems)
    .leftJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, order.id));

    return { ...order, items };
  },

  async createOrder(data: any, items: any[]) {
    const result = await db.insert(orders).values(data).returning();
    const order = result[0];
    if (items.length > 0) {
      await db.insert(orderItems).values(
        items.map(i => ({ ...i, orderId: order.id }))
      );
    }
    return storage.getOrder(order.id);
  },

  async updateOrder(id: number, data: any) {
    const result = await db.update(orders).set(data).where(eq(orders.id, id)).returning();
    return result[0];
  },

  // ── Withdrawals ──
  async getWithdrawals(merchantId?: number) {
    const result = merchantId
      ? await db.select().from(withdrawals).where(eq(withdrawals.merchantId, merchantId))
      : await db.select().from(withdrawals);
    return result.sort((a, b) =>
      new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()
    );
  },

  async getWithdrawal(id: number) {
    const result = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    return result[0] || null;
  },

  async createWithdrawal(data: any) {
    const result = await db.insert(withdrawals).values(data).returning();
    return result[0];
  },

  async updateWithdrawal(id: number, data: any) {
    const result = await db.update(withdrawals).set(data).where(eq(withdrawals.id, id)).returning();
    return result[0];
  },

  // ── Favorites ──
  async getFavorites(userId: number) {
    return await db.select().from(favorites).where(eq(favorites.userId, userId));
  },

  async addFavorite(userId: number, productId: number) {
    const existing = await db.select().from(favorites)
      .where(eq(favorites.userId, userId));
    const alreadyExists = existing.find((f: any) => f.productId === productId);
    if (alreadyExists) return alreadyExists;
    const result = await db.insert(favorites).values({ userId, productId }).returning();
    return result[0];
  },

  async removeFavorite(userId: number, productId: number) {
    await db.delete(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.productId, productId)));
    return { success: true };
  },

  async isFavorite(userId: number, productId: number) {
    const result = await db.select().from(favorites).where(eq(favorites.userId, userId));
    return result.some(f => f.productId === productId);
  },

  // ═══════════════════════════════════════════════════════════════
  // ── Promo Codes ──
  // ═══════════════════════════════════════════════════════════════

  async getPromoCodes() {
    const all = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
    return all;
  },

  async getPromoCode(id: number) {
    const result = await db.select().from(promoCodes).where(eq(promoCodes.id, id));
    return result[0] || null;
  },

  async getPromoCodeByCode(code: string) {
    const result = await db.select().from(promoCodes)
      .where(eq(promoCodes.code, code.toUpperCase()))
      .limit(1);
    return result[0] || null;
  },

  async createPromoCode(data: any) {
    const result = await db.insert(promoCodes).values(data).returning();
    return result[0];
  },

  async updatePromoCode(id: number, data: any) {
    const updateData = { ...data, updatedAt: new Date() };
    const result = await db.update(promoCodes).set(updateData)
      .where(eq(promoCodes.id, id)).returning();
    return result[0];
  },

  async deletePromoCode(id: number) {
    await db.delete(promoUsages).where(eq(promoUsages.promoId, id));
    await db.delete(promoCodes).where(eq(promoCodes.id, id));
  },

  async incrementPromoUsedCount(id: number) {
    await db.execute(
      sql`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ${id}`
    );
  },

  async decrementPromoUsedCount(id: number) {
    await db.execute(
      sql`UPDATE promo_codes SET used_count = GREATEST(0, used_count - 1) WHERE id = ${id}`
    );
  },

  // ── Promo Usages ──
  async createPromoUsage(data: {
    promoId: number;
    userId: number;
    orderId: number;
    discountAmount: number;
  }) {
    const result = await db.insert(promoUsages).values(data).returning();
    return result[0];
  },

  async getUserPromoUsageCount(promoId: number, userId: number) {
    const result = await db.execute(
      sql`SELECT COUNT(*) as count FROM promo_usages
          WHERE promo_id = ${promoId} AND user_id = ${userId}`
    );
    return Number((result.rows[0] as any)?.count || 0);
  },

  async getPromoUsages(promoId: number) {
    return await db.select().from(promoUsages)
      .where(eq(promoUsages.promoId, promoId))
      .orderBy(desc(promoUsages.createdAt));
  },

  async getPromoStats(promoId: number) {
    const result = await db.execute(
      sql`SELECT
            COUNT(*) as usage_count,
            COALESCE(SUM(discount_amount), 0) as total_discount,
            COUNT(DISTINCT user_id) as unique_users
          FROM promo_usages
          WHERE promo_id = ${promoId}`
    );
    const row = result.rows[0] as any;
    return {
      usageCount: Number(row?.usage_count || 0),
      totalDiscount: Number(row?.total_discount || 0),
      uniqueUsers: Number(row?.unique_users || 0),
    };
  },

  async deletePromoUsageByOrder(orderId: number) {
    await db.delete(promoUsages).where(eq(promoUsages.orderId, orderId));
  },

  // ═══════════════════════════════════════════════════════════════
  // ── Campaigns (الحملات / التحديات) ──
  // ═══════════════════════════════════════════════════════════════

  // ── CRUD أساسي ──
  async getCampaigns() {
    const list = await db.select().from(campaigns)
      .orderBy(desc(campaigns.createdAt));
    // إضافة معلومات المنتج لكل حملة
    return await Promise.all(list.map(async (c: any) => {
      const product = await db.select().from(products)
        .where(eq(products.id, c.productId)).limit(1);
      return { ...c, product: product[0] || null };
    }));
  },

  async getCampaign(id: number) {
    const result = await db.select().from(campaigns)
      .where(eq(campaigns.id, id)).limit(1);
    if (!result[0]) return null;

    const campaign = result[0];
    const product = await db.select().from(products)
      .where(eq(products.id, campaign.productId)).limit(1);

    return { ...campaign, product: product[0] || null };
  },

  async createCampaign(data: any) {
    const result = await db.insert(campaigns).values(data).returning();
    return result[0];
  },

  async updateCampaign(id: number, data: any) {
    const result = await db.update(campaigns).set(data)
      .where(eq(campaigns.id, id)).returning();
    return result[0];
  },

  async deleteCampaign(id: number) {
    // حذف كل البيانات المرتبطة
    await db.delete(campaignRewards).where(eq(campaignRewards.campaignId, id));
    await db.delete(campaignOrders).where(eq(campaignOrders.campaignId, id));
    await db.delete(campaignParticipants).where(eq(campaignParticipants.campaignId, id));
    await db.delete(campaigns).where(eq(campaigns.id, id));
  },

  // ── للمشاركين ──
  async getCampaignParticipants(campaignId: number) {
    const participants = await db.select().from(campaignParticipants)
      .where(eq(campaignParticipants.campaignId, campaignId))
      .orderBy(desc(campaignParticipants.progressCount));

    // إضافة اسم المتجر لكل مشارك
    return await Promise.all(participants.map(async (p: any) => {
      const user = await db.select({
        id: users.id,
        storeName: users.storeName,
        phone: users.phone,
      }).from(users).where(eq(users.id, p.userId)).limit(1);
      return { ...p, user: user[0] || null };
    }));
  },

  async getParticipant(campaignId: number, userId: number) {
    const result = await db.select().from(campaignParticipants).where(
      and(
        eq(campaignParticipants.campaignId, campaignId),
        eq(campaignParticipants.userId, userId)
      )
    ).limit(1);
    return result[0] || null;
  },

  async createParticipant(data: any) {
    const result = await db.insert(campaignParticipants).values(data).returning();
    return result[0];
  },

  async updateParticipant(id: number, data: any) {
    const result = await db.update(campaignParticipants).set(data)
      .where(eq(campaignParticipants.id, id)).returning();
    return result[0];
  },

  // ── للتاجر: كل حملاته مع تفاصيل التقدم ──
  async getUserCampaigns(userId: number) {
    const now = new Date();

    // كل الحملات النشطة (يشارك فيها أو لا)
    const allCampaigns = await db.select().from(campaigns)
      .orderBy(desc(campaigns.createdAt));

    return await Promise.all(allCampaigns.map(async (c: any) => {
      const product = await db.select().from(products)
        .where(eq(products.id, c.productId)).limit(1);

      const participant = await db.select().from(campaignParticipants).where(
        and(
          eq(campaignParticipants.campaignId, c.id),
          eq(campaignParticipants.userId, userId)
        )
      ).limit(1);

      const isActive = c.isActive &&
        new Date(c.startsAt) <= now &&
        new Date(c.endsAt) >= now;

      const isExpired = new Date(c.endsAt) < now;

      return {
        ...c,
        product: product[0] || null,
        isActive,
        isExpired,
        isParticipating: participant.length > 0,
        progressCount: participant[0]?.progressCount || 0,
        targetReached: participant[0]?.targetReached || false,
        rewardClaimed: participant[0]?.rewardClaimed || false,
      };
    }));
  },

  // ── للتفاصيل: الحملة + التقدم + المكافآت المصروفة ──
  async getCampaignWithProgress(campaignId: number, userId: number) {
    const campaign = await storage.getCampaign(campaignId);
    if (!campaign) return null;

    const participant = await storage.getParticipant(campaignId, userId);

    const rewards = await db.select().from(campaignRewards).where(
      and(
        eq(campaignRewards.campaignId, campaignId),
        eq(campaignRewards.userId, userId)
      )
    );

    const orders = await db.select().from(campaignOrders).where(
      and(
        eq(campaignOrders.campaignId, campaignId),
        eq(campaignOrders.userId, userId)
      )
    ).orderBy(desc(campaignOrders.createdAt));

    return {
      ...campaign,
      participant: participant || null,
      rewards,
      orders,
    };
  },

  // ── مكافآت المستخدم ──
  async getUserCampaignRewards(userId: number) {
    const rewards = await db.select().from(campaignRewards)
      .where(eq(campaignRewards.userId, userId))
      .orderBy(desc(campaignRewards.createdAt));

    // إضافة معلومات الحملة
    return await Promise.all(rewards.map(async (r: any) => {
      const campaign = await db.select({
        id: campaigns.id,
        title: campaigns.title,
        rewardType: campaigns.rewardType,
      }).from(campaigns).where(eq(campaigns.id, r.campaignId)).limit(1);
      return { ...r, campaign: campaign[0] || null };
    }));
  },

  // ── Campaign Orders (السجل) ──
  async getCampaignOrders(campaignId: number, userId?: number) {
    let query = db.select().from(campaignOrders)
      .where(eq(campaignOrders.campaignId, campaignId));

    if (userId) {
      query = db.select().from(campaignOrders).where(
        and(
          eq(campaignOrders.campaignId, campaignId),
          eq(campaignOrders.userId, userId)
        )
      );
    }

    return await query.orderBy(desc(campaignOrders.createdAt));
  },

  async createCampaignOrder(data: any) {
    const result = await db.insert(campaignOrders).values(data).returning();
    return result[0];
  },

  async updateCampaignOrder(id: number, data: any) {
    const result = await db.update(campaignOrders).set(data)
      .where(eq(campaignOrders.id, id)).returning();
    return result[0];
  },

  // ── إحصائيات الحملة (للأدمن) ──
  async getCampaignStats(campaignId: number) {
    const result = await db.execute(sql`
      SELECT
        COUNT(DISTINCT user_id) as participants_count,
        COUNT(*) FILTER (WHERE status = 'counted') as counted_orders,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_orders
      FROM campaign_orders
      WHERE campaign_id = ${campaignId}
    `);
    const row = result.rows[0] as any;

    const winners = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM campaign_participants
      WHERE campaign_id = ${campaignId} AND target_reached = TRUE
    `);

    return {
      participantsCount: Number(row?.participants_count || 0),
      countedOrders: Number(row?.counted_orders || 0),
      rejectedOrders: Number(row?.rejected_orders || 0),
      winnersCount: Number((winners.rows[0] as any)?.count || 0),
    };
  },
};
