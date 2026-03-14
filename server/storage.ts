import { db } from "./db";
import { users, products, orders, orderItems, withdrawals, favorites } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export const storage = {
  // Users
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
    // ✅ whitelist — فقط الحقول المسموحة تُحدَّث
    const ALLOWED: (keyof typeof data)[] = [
      'storeName', 'phone', 'address', 'password',
      'balance', 'role', 'isActive', 'permissions',
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
    // ✅ إخفاء الباسورد من قائمة المستخدمين
    return all.map(({ password, ...safe }: any) => safe);
  },

  async deleteUser(id: number) {
    await db.delete(users).where(eq(users.id, id));
  },

  // Products
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

  // Orders
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

  // Withdrawals
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

  // Favorites
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
};
