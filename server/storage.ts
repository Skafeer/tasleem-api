import { db } from "./db";
import { users, products, orders, orderItems, withdrawals } from "@shared/schema";
import { eq } from "drizzle-orm";

export const storage = {
  // Users
  async getUser(id: number) {
    return db.query.users.findFirst({ where: eq(users.id, id) });
  },
  async getUserByPhone(phone: string) {
    return db.query.users.findFirst({ where: eq(users.phone, phone) });
  },
  async createUser(data: any) {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  },
  async updateUser(id: number, data: any) {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user;
  },

  // Products
  async getProducts() {
    return db.query.products.findMany({ orderBy: (p, { desc }) => [desc(p.createdAt)] });
  },
  async getProduct(id: number) {
    return db.query.products.findFirst({ where: eq(products.id, id) });
  },
  async createProduct(data: any) {
    const [product] = await db.insert(products).values(data).returning();
    return product;
  },
  async updateProduct(id: number, data: any) {
    const [product] = await db.update(products).set(data).where(eq(products.id, id)).returning();
    return product;
  },
  async deleteProduct(id: number) {
    await db.delete(products).where(eq(products.id, id));
  },

  // Orders
  async getOrders(merchantId?: number) {
    if (merchantId) {
      return db.query.orders.findMany({
        where: eq(orders.merchantId, merchantId),
        orderBy: (o, { desc }) => [desc(o.createdAt)],
        with: { items: { with: { product: true } } },
      });
    }
    return db.query.orders.findMany({
      orderBy: (o, { desc }) => [desc(o.createdAt)],
      with: { items: { with: { product: true } } },
    });
  },
  async getOrder(id: number) {
    return db.query.orders.findFirst({
      where: eq(orders.id, id),
      with: { items: { with: { product: true } } },
    });
  },
  async createOrder(data: any, items: any[]) {
    const [order] = await db.insert(orders).values(data).returning();
    if (items.length > 0) {
      await db.insert(orderItems).values(
        items.map(i => ({ ...i, orderId: order.id }))
      );
    }
    return storage.getOrder(order.id);
  },
  async updateOrder(id: number, data: any) {
    const [order] = await db.update(orders).set(data).where(eq(orders.id, id)).returning();
    return order;
  },

  // Withdrawals
  async getWithdrawals(merchantId?: number) {
    if (merchantId) {
      return db.query.withdrawals.findMany({
        where: eq(withdrawals.merchantId, merchantId),
        orderBy: (w, { desc }) => [desc(w.createdAt)],
      });
    }
    return db.query.withdrawals.findMany({
      orderBy: (w, { desc }) => [desc(w.createdAt)],
    });
  },
  async createWithdrawal(data: any) {
    const [w] = await db.insert(withdrawals).values(data).returning();
    return w;
  },
  async updateWithdrawal(id: number, data: any) {
    const [w] = await db.update(withdrawals).set(data).where(eq(withdrawals.id, id)).returning();
    return w;
  },
};

// مضاف للـ storage object — افتح الملف يدوياً وأضف هذا داخل الـ object

export async function getAllUsers() {
  return db.query.users.findMany({
    orderBy: (u, { desc }) => [desc(u.createdAt)],
  });
}

export async function getAllUsers() {
  return db.query.users.findMany({
    orderBy: (u, { desc }) => [desc(u.createdAt)],
  });
}
