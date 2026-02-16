import { pgTable, text, serial, integer, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  password: text("password").notNull(),
  storeName: text("store_name").notNull(),
  address: text("address").notNull().default(""),
  role: text("role").notNull().default("merchant"),
  merchantId: text("merchant_id").notNull().unique(),
  balance: real("balance").notNull().default(0),
  pendingBalance: real("pending_balance").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  wholesalePrice: real("wholesale_price").notNull(),
  sellingPriceMin: real("selling_price_min").notNull(),
  category: text("category").notNull().default("عام"),
  imageUrl: text("image_url").notNull().default(""),
  stock: integer("stock").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull(),
  province: text("province").notNull(),
  address: text("address").notNull(),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("pending"),
  totalAmount: real("total_amount").notNull().default(0),
  shippingCost: real("shipping_cost").notNull().default(0),
  totalProfit: real("total_profit").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  productId: integer("product_id").notNull(),
  quantity: integer("quantity").notNull(),
  price: real("price").notNull(),
  cost: real("cost").notNull().default(0),
});

export const withdrawals = pgTable("withdrawals", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  amount: real("amount").notNull(),
  method: text("method").notNull(),
  accountDetails: text("account_details").notNull().default(""),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
