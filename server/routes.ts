import { saqrAssistant } from "./saqrService";
import { Express, Request, Response } from "express";
import { Server } from "http";
import { setupAuth, requireAuth } from "./auth";
const saqrLimiter = rateLimit(10, 60_000); // 10 طلبات/دقيقة فقط


// ✅ إخفاء البيانات الحساسة قبل إرسالها للعميل

function sanitizeUser(user: any, isAdmin = false) {

if (!user) return null;

const { password, ...safe } = user;

if (!isAdmin) {

// التاجر ما يشوف هذي الحقول

const { companyWholesalePrice, isSuperAdmin, is_super_admin, permissions, ...merchant } = safe;

return merchant;

}

return safe;

}


// ✅ Validation helpers

function validatePhone(phone: string) {

return /^07[0-9]{9}$/.test(phone?.trim());

}

function validateAmount(amount: any) {

const n = Number(amount);

return !isNaN(n) && n > 0 && n < 100_000_000;

}

function validateString(str: any, maxLen = 500) {

return typeof str === 'string' && str.trim().length > 0 && str.length <= maxLen;

}

import { setupUpload } from "./upload";

import { storage } from "./storage";

import { db } from "./db";

import { promoCodes, products, orders, orderItems, banners, withdrawals, favorites, notifications, pushTokens, supportMessages, categories, inventoryLog } from "@shared/schema";

import { eq, sql } from "drizzle-orm";

import bcrypt from "bcryptjs";


// ── Rate Limiter بسيط بدون مكتبة ──

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();


function rateLimit(maxRequests: number, windowMs: number) {

return (req: any, res: any, next: any) => {

const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';

const now = Date.now();

const entry = rateLimitMap.get(key);


if (!entry || now > entry.resetAt) {

rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });

return next();

}


entry.count++;

if (entry.count > maxRequests) {

return res.status(429).json({ message: 'طلبات كثيرة جدًا، حاول بعد قليل' });

}

next();

};

}


// حدود مختلفة لكل نوع

const authLimiter = rateLimit(10, 60_000); // 10 محاولات/دقيقة للـ login

const generalLimiter = rateLimit(100, 60_000); // 100 طلب/دقيقة للباقي

const broadcastLimiter = rateLimit(5, 60_000); // 5 إشعارات/دقيقة


// ── helper: تحقق من صلاحية معينة ──

const hasPermission = (user: any, perm: string): boolean => {

if (user.role !== 'admin') return false;

if (user.isSuperAdmin || user.is_super_admin) return true;

try {

const perms: string[] = JSON.parse(user.permissions || '[]');

return perms.includes(perm);

} catch { return false; }

};


export async function registerRoutes(httpServer: Server, app: Express) {

setupAuth(app);

setupUpload(app);

		// ── Saqr AI Assistant ──
		app.post("/api/saqr/analyze", requireAuth, saqrLimiter, async (req: any, res) => {
			try {
				const { identifier } = req.body;
				if (!identifier) return res.status(400).json({ message: "يرجى تزويد كود المنتج أو اسمه" });
				const analysis = await saqrAssistant.analyzeProduct(identifier, req.user.id);
				res.json({ analysis });
			} catch (e) { res.status(500).json({ message: "حدث خطأ في استدعاء صقر" }); }
		});


// ── Migrations: إضافة أعمدة الصلاحيات ──

try {

await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE`);

await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT NOT NULL DEFAULT '[]'`);

// أول أدمن موجود يصير super admin تلقائياً

await db.execute(`UPDATE users SET is_super_admin = TRUE WHERE role = 'admin' AND (is_super_admin IS NULL OR is_super_admin = FALSE) AND id = (SELECT MIN(id) FROM users WHERE role = 'admin')`);

console.log('✅ Admin permissions migration done');

} catch (e) { console.log('Migration note:', e); }


// ── Migration: جدول المفضلة ──

try {

await db.execute(`CREATE TABLE IF NOT EXISTS favorites (

id SERIAL PRIMARY KEY,

user_id INTEGER NOT NULL,

product_id INTEGER NOT NULL,

created_at TIMESTAMP DEFAULT NOW(),

UNIQUE(user_id, product_id)

)`);

console.log('✅ Favorites migration done');

} catch (e) { console.log('Favorites migration note:', e); }


// ── Migration: جدول الشات ──

try {

await db.execute(`CREATE TABLE IF NOT EXISTS support_messages (

id SERIAL PRIMARY KEY,

user_id INTEGER NOT NULL,

from_admin BOOLEAN NOT NULL DEFAULT FALSE,

message TEXT NOT NULL,

is_read BOOLEAN NOT NULL DEFAULT FALSE,

created_at TIMESTAMP DEFAULT NOW()

)`);

console.log('✅ Support messages migration done');

} catch (e) { console.log('Support migration note:', e); }


// ── Migration: تحديث جدول الشات ──

try {

await db.execute(`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS image_url TEXT`);

await db.execute(`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE`);

await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS support_blocked BOOLEAN NOT NULL DEFAULT FALSE`);

console.log('✅ Support updates migration done');

} catch (e) { console.log('Support updates migration note:', e); }


// ── Products ──

app.get("/api/products", async (req: any, res) => {

try {

const all = await storage.getProducts();

const activeOnly = req.query.activeOnly === 'true';

res.json(activeOnly ? all.filter((p: any) => p.isActive !== false) : all);

}

catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.get("/api/products/:id", async (req, res) => {

try {

const p = await storage.getProduct(Number(req.params.id));

if (!p) return res.status(404).json({ message: "المنتج غير موجود" });

res.json(p);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post("/api/products", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try { res.status(201).json(await storage.createProduct(req.body)); }

catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.put("/api/products/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try { res.json(await storage.updateProduct(Number(req.params.id), req.body)); }

catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.delete("/api/products/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try { await storage.deleteProduct(Number(req.params.id)); res.json({ message: "تم الحذف" }); }

catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ── Orders ──

app.get("/api/orders", requireAuth, async (req: any, res) => {
try {
  // ✅ الأدمن يقدر يفلتر بـ merchantId من الـ query — التاجر دائماً يشوف طلباته فقط
  let merchantId: number | undefined;
  if (req.user.role === 'admin') {
    // إذا أرسل merchantId بالـ query استخدمه، وإلا اجلب كل الطلبات
    merchantId = req.query.merchantId ? Number(req.query.merchantId) : undefined;
  } else {
    merchantId = req.user.id;
  }

const page = Math.max(1, Number(req.query.page) || 1);

const limit = Math.min(50, Number(req.query.limit) || 20);

const status = req.query.status as string | undefined;

const search = req.query.search as string | undefined;

const offset = (page - 1) * limit;


// جلب كل الطلبات ثم فلترة وpagination

let all = await storage.getOrders(merchantId);


if (status && status !== 'all') {

all = all.filter((o: any) => o.status === status);

}

if (search) {

const s = search.toLowerCase();

all = all.filter((o: any) =>

String(o.id).includes(s) ||

o.customerName?.toLowerCase().includes(s) ||

o.customerPhone?.includes(s)

);

}


const total = all.length;

const data = all.slice(offset, offset + limit);


res.json({

data,

page,

limit,

total,

totalPages: Math.ceil(total / limit),

hasMore: offset + limit < total,

});

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.get("/api/orders/:id", requireAuth, async (req: any, res) => {

try {

const order = await storage.getOrder(Number(req.params.id));

if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

if (req.user.role !== "admin" && order.merchantId !== req.user.id)

return res.status(403).json({ message: "غير مصرح" });

res.json(order);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post("/api/orders", requireAuth, generalLimiter, async (req: any, res) => {

try {

const { items, customerName, customerPhone, province, address, notes, promoCode } = req.body;

if (!items || !Array.isArray(items) || items.length === 0)

return res.status(400).json({ message: "يجب إضافة منتج واحد على الأقل" });

if (items.length > 50)

return res.status(400).json({ message: "الحد الأقصى 50 منتج في الطلب" });

if (!validateString(customerName, 100))

return res.status(400).json({ message: "اسم الزبون غير صحيح" });

if (!validatePhone(customerPhone))

return res.status(400).json({ message: "رقم الهاتف يجب أن يبدأ بـ 07 ويكون 11 رقم" });

if (!validateString(province, 50))

return res.status(400).json({ message: "المحافظة مطلوبة" });

if (!validateString(address, 500))

return res.status(400).json({ message: "العنوان مطلوب" });


let totalAmount = 0, totalCost = 0, totalCompanyCost = 0;

const enrichedItems = await Promise.all(items.map(async (item: any) => {

const product = await storage.getProduct(Number(item.productId));

if (!product) throw new Error(`المنتج ${item.productId} غير موجود`);

const qty = Number(item.quantity);

const price = Number(item.sellingPrice);


// ✅ التحقق من أن سعر البيع >= أدنى سعر

if (price < product.sellingPriceMin) {

throw new Error(`سعر البيع أقل من الحد الأدنى المسموح (${product.sellingPriceMin})`);

}


totalAmount += price * qty;

totalCost += product.wholesalePrice * qty;

totalCompanyCost += (product.companyWholesalePrice || 0) * qty;

return { productId: Number(item.productId), quantity: qty, price, cost: product.wholesalePrice };

}));


// Promo code

let promoDiscount = 0, validPromo = "";

if (promoCode) {

const promo = await db.select().from(promoCodes).where(eq(promoCodes.code, promoCode.toUpperCase()));

if (promo[0]?.isActive) {

promoDiscount = (totalAmount * promo[0].discountPercent) / 100;

validPromo = promoCode.toUpperCase();

}

}


const isBasra = province.includes("البصرة");

const shippingCost = isBasra ? 3000 : 5000;

const totalProfit = totalAmount - totalCost - promoDiscount;

const companyProfit = totalCost - totalCompanyCost;

const finalAmount = totalAmount + shippingCost - promoDiscount;


const order = await storage.createOrder({

merchantId: req.user.id,

customerName, customerPhone, province, address,

notes: notes || "", status: "pending",

totalAmount: finalAmount, shippingCost, totalProfit, companyProfit,

promoCode: validPromo, promoDiscount,

}, enrichedItems);


// ✅ تخفيض المخزون

await Promise.all(enrichedItems.map(async (item: any) => {
  const product = await storage.getProduct(item.productId);
  if (product) {
    const newStock = Math.max(0, product.stock - item.quantity);
    await storage.updateProduct(item.productId, { stock: newStock });

    // سجّل في inventory_log
    await db.insert(inventoryLog).values({
      productId: item.productId, adminId: null,
      change: -item.quantity, reason: 'order',
      note: `طلب #${order?.id}`, stockAfter: newStock,
    }).catch(() => {});

    // إشعار للأدمن لو نفد المخزون
    if (newStock === 0) {
      try {
        const adminUsers = await db.execute(sql`SELECT id FROM users WHERE role = 'admin'`);
        const adminIds = (adminUsers.rows as any[]).map((u: any) => u.id);
        if (adminIds.length > 0) {
          const { sendPushNotification } = await import('./notifications');
          await sendPushNotification({
            userIds: adminIds,
            title: '⚠️ نفد المخزون',
            body: `المنتج "${product.name}" نفد المخزون بالكامل`,
            data: { type: 'stock_out', productId: String(item.productId) },
          });
        }
      } catch (_) {}
    }
  }
}));


// تحديث رصيد التاجر

const freshUser = await storage.getUser(req.user.id);

if (freshUser) {

await storage.updateUser(req.user.id, {

pendingBalance: (freshUser.pendingBalance || 0) + totalProfit,

});

}

// ✅ إشعار للأدمن عند إنشاء طلب جديد
try {
  const adminUsers = await db.execute(sql`SELECT id FROM users WHERE role = 'admin'`);
  const adminIds = (adminUsers.rows as any[]).map((u: any) => u.id);
  if (adminIds.length > 0) {
    const { sendPushNotification } = await import('./notifications');
    await sendPushNotification({
      userIds: adminIds,
      title: '🛍 طلب جديد',
      body: `طلب جديد #${order?.id} من ${req.user.storeName} — ${finalAmount.toLocaleString()} د.ع`,
      data: { type: 'new_order', orderId: String(order?.id ?? '') },
    });
  }
} catch (_) {}

res.status(201).json(order);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.patch("/api/orders/:id/status", requireAuth, async (req: any, res) => {
if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
try {
  const VALID_STATUSES = ['pending','processing','preparing','shipping','delivered','cancelled','returned','postponed'];
  if (!VALID_STATUSES.includes(req.body.status))
    return res.status(400).json({ message: 'حالة غير صحيحة' });

  const order = await storage.getOrder(Number(req.params.id));
  if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

  const updated = await storage.updateOrder(Number(req.params.id), { status: req.body.status });

if (req.body.status === "delivered" && order.status !== "delivered") {
  // ✅ Fix: Atomic update لمنع race condition
  await db.execute(
    sql`UPDATE users
        SET balance = balance + ${order.totalProfit},
            pending_balance = GREATEST(0, pending_balance - ${order.totalProfit})
        WHERE id = ${order.merchantId}`
  );
}

// ✅ استعادة المخزون — فقط إذا كانت الحالة السابقة تستوجب خصم المخزون
// الحالات التي لا تستوجب استعادة: cancelled, returned (المخزون رجع مسبقاً)
const STOCK_ALREADY_RESTORED = ['cancelled', 'returned'];
const isMovingToTerminal =
  (req.body.status === 'returned' || req.body.status === 'cancelled');
const wasAlreadyRestored = STOCK_ALREADY_RESTORED.includes(order.status);

// نستعيد فقط إذا: الحالة الجديدة terminal + الحالة القديمة لم تكن terminal
const shouldRestoreStock = isMovingToTerminal && !wasAlreadyRestored;

if (shouldRestoreStock) {
  const fullOrder = await storage.getOrder(order.id);
  if (fullOrder?.items) {
    await Promise.all(fullOrder.items.map(async (item: any) => {
      const product = await storage.getProduct(item.productId);
      if (product) {
        const newStock = product.stock + item.quantity;
        await storage.updateProduct(item.productId, { stock: newStock });

        // ✅ سجّل في inventory_log
        await db.insert(inventoryLog).values({
          productId: item.productId,
          adminId: req.user.id,
          change: item.quantity,
          reason: req.body.status === "cancelled" ? "cancel" : "returned",
          note: `طلب #${order.id} — ${req.body.status === "cancelled" ? "ملغي" : "مرتجع"}`,
          stockAfter: newStock,
        }).catch(() => {});
      }
    }));
  }
}

const STATUS_LABELS: Record<string, string> = {

pending: 'قيد الانتظار ⏳',

processing: 'قيد المعالجة 🔄',

preparing: 'قيد التجهيز 📦',

shipping: 'قيد التوصيل 🚴',

delivered: 'تم التوصيل ✅',

cancelled: 'ملغي ❌',

returned: 'راجع 🔙',

postponed: 'مؤجل ⏸',

};

try {

const { sendPushNotification } = await import('./notifications');

await sendPushNotification({

userIds: [order.merchantId],

title: 'تحديث حالة الطلب',

body: `طلبك رقم #${order.id} أصبح: ${STATUS_LABELS[req.body.status] || req.body.status}`,

data: { type: 'order_status', orderId: order.id, status: req.body.status },

});

} catch (_) {}

res.json(updated);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});



// ── Edit Order (Admin) ──

app.put("/api/orders/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

const orderId = Number(req.params.id);

const order = await storage.getOrder(orderId);

if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

const { customerName, customerPhone, province, address, notes, items } = req.body;

let updateData: any = {};

if (customerName !== undefined) updateData.customerName = customerName;

if (customerPhone !== undefined) updateData.customerPhone = customerPhone;

if (province !== undefined) updateData.province = province;

if (address !== undefined) updateData.address = address;

if (notes !== undefined) updateData.notes = notes;

if (items && Array.isArray(items)) {

await db.delete(orderItems).where(eq(orderItems.orderId, orderId));

let totalAmount = 0, totalCost = 0;

const enriched = await Promise.all(items.map(async (item: any) => {

const product = await storage.getProduct(Number(item.productId));

if (!product) throw new Error("منتج غير موجود");

const qty = Number(item.quantity);

const price = Number(item.price);

totalAmount += price * qty;

totalCost += product.wholesalePrice * qty;

return { orderId, productId: Number(item.productId), quantity: qty, price, cost: product.wholesalePrice };

}));

await db.insert(orderItems).values(enriched);

const shippingCost = order.shippingCost || 5000;

const promoDiscount = order.promoDiscount || 0;

updateData.totalAmount = totalAmount + shippingCost - promoDiscount;

updateData.totalProfit = totalAmount - totalCost - promoDiscount;

}

await storage.updateOrder(orderId, updateData);

const fresh = await storage.getOrder(orderId);

res.json(fresh);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ── Delete Order (Admin) ──

app.delete("/api/orders/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

const orderId = Number(req.params.id);

const order = await storage.getOrder(orderId);

if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

await db.delete(orderItems).where(eq(orderItems.orderId, orderId));

await db.delete(orders).where(eq(orders.id, orderId));

res.json({ message: "تم حذف الطلب" });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ── Withdrawals ──

app.get("/api/withdrawals", requireAuth, async (req: any, res) => {

try {

const merchantId = req.user.role === "admin" ? undefined : req.user.id;

res.json(await storage.getWithdrawals(merchantId));

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post("/api/withdrawals", requireAuth, generalLimiter, async (req: any, res) => {
try {
  const amt = Number(req.body.amount);
  if (!validateAmount(amt))
    return res.status(400).json({ message: 'مبلغ غير صحيح' });

  // ✅ FIX: Atomic balance deduction - prevents race condition
  const updateResult = await db.execute(
    sql`UPDATE users SET balance = balance - ${amt} WHERE id = ${req.user.id} AND balance >= ${amt} RETURNING balance`
  );

  if (!updateResult.rows || updateResult.rows.length === 0) {
    return res.status(400).json({ message: 'رصيد غير كافٍ' });
  }

  const w = await storage.createWithdrawal({
    merchantId: req.user.id, amount: amt,
    method: req.body.method || "manual",
    accountDetails: req.body.accountDetails || "",
    status: "pending",
  });

  res.status(201).json(w);
} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});


app.patch("/api/withdrawals/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

const wId = Number(req.params.id);

const newStatus = req.body.status;

const w = await storage.getWithdrawal(wId);

if (!w) return res.status(404).json({ message: "طلب السحب غير موجود" });

await storage.updateWithdrawal(wId, { status: newStatus });

if (newStatus === "rejected" && w.status !== "rejected") {

const merchant = await storage.getUser(w.merchantId);

if (merchant) await storage.updateUser(w.merchantId, { balance: (merchant.balance || 0) + w.amount });

}

const W_LABELS: Record<string, string> = {

pending: 'قيد الانتظار ⏳',

approved: 'تم القبول ✅',

paid: 'تم الدفع 💰',

rejected: 'مرفوض ❌',

};

try {

const { sendPushNotification } = await import('./notifications');

await sendPushNotification({

userIds: [w.merchantId],

title: 'تحديث طلب السحب',

body: `طلب سحب ${w.amount.toLocaleString()} د.ع أصبح: ${W_LABELS[newStatus] || newStatus}`,

data: { type: 'withdrawal_status', withdrawalId: wId, status: newStatus },

});

} catch (_) {}

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ── Profile ──

app.patch("/api/auth/profile", requireAuth, async (req: any, res) => {

try {

// ✅ فقط الحقول المسموح للتاجر تعديلها

const { storeName, phone, address, password } = req.body;

const updateData: any = {};

if (storeName !== undefined) {

if (!validateString(storeName, 100)) return res.status(400).json({ message: 'اسم المتجر غير صحيح' });

updateData.storeName = storeName.trim();

}

if (phone !== undefined) {

if (!validatePhone(phone)) return res.status(400).json({ message: 'رقم الهاتف غير صحيح' });

updateData.phone = phone.trim();

}

if (address !== undefined) {

if (!validateString(address, 300)) return res.status(400).json({ message: 'العنوان غير صحيح' });

updateData.address = address.trim();

}

if (password !== undefined && password.trim() !== '') {

const bcrypt = await import('bcryptjs');

updateData.password = await bcrypt.hash(password, 10);

}

// ❌ balance و role و merchantId محمية — التاجر ما يقدر يعدلها

const updated = await storage.updateUser(req.user.id, updateData);

res.json(sanitizeUser(updated));

}

catch (e: any) { res.status(500).json({ message: 'حدث خطأ' }); }

});


// ── Admin Users ──

app.get("/api/admin/users", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try { res.json(await storage.getAllUsers()); }

catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.patch("/api/admin/users/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

const userId = Number(req.params.id);

const { storeName, phone, address, password, balance } = req.body;

const updateData: any = {};

if (storeName !== undefined) updateData.storeName = storeName;

if (phone !== undefined) updateData.phone = phone;

if (address !== undefined) updateData.address = address;

if (balance !== undefined) updateData.balance = Number(balance);

if (password !== undefined && password.trim() !== "") {

const bcrypt = await import("bcryptjs");

updateData.password = await bcrypt.hash(password, 10);

}

const updated = await storage.updateUser(userId, updateData);

res.json(updated);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.delete("/api/admin/users/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

await storage.deleteUser(Number(req.params.id));

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});



// ── Promo Codes ──

app.get("/api/promo-codes", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try { res.json(await db.select().from(promoCodes)); }

catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post("/api/promo-codes", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

const result = await db.insert(promoCodes)

.values({ code: req.body.code.toUpperCase(), discountPercent: Number(req.body.discountPercent), isActive: true })

.returning();

res.status(201).json(result[0]);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.delete("/api/promo-codes/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

await db.delete(promoCodes).where(eq(promoCodes.id, Number(req.params.id)));

res.json({ message: "تم الحذف" });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});



app.patch("/api/promo-codes/:id", requireAuth, async (req: any, res) => {

if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

try {

const { code, discountPercent, isActive } = req.body;

const updateData: any = {};

if (code !== undefined) updateData.code = code.toUpperCase();

if (discountPercent !== undefined) updateData.discountPercent = Number(discountPercent);

if (isActive !== undefined) updateData.isActive = isActive;

const result = await db.update(promoCodes).set(updateData).where(eq(promoCodes.id, Number(req.params.id))).returning();

res.json(result[0]);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post("/api/promo-codes/verify", generalLimiter, async (req, res) => {

try {

const result = await db.select().from(promoCodes).where(eq(promoCodes.code, req.body.code.toUpperCase()));

if (!result[0]?.isActive) return res.status(404).json({ message: "كود غير صحيح أو منتهي الصلاحية" });

res.json({ discountPercent: result[0].discountPercent });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});



// ── Banners ──

app.get('/api/banners', async (req, res) => {

try {

const result = await db.select().from(banners).orderBy(banners.sortOrder);

res.json(result);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post('/api/banners', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const result = await db.insert(banners).values(req.body).returning();

res.json(result[0]);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.patch('/api/banners/:id', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const { title, imageUrl, link, isActive, sortOrder } = req.body;

const updateData: any = {};

if (title !== undefined) updateData.title = title;

if (imageUrl !== undefined) updateData.imageUrl = imageUrl;

if (link !== undefined) updateData.link = link;

if (isActive !== undefined) updateData.isActive = Boolean(isActive);

if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder);

const result = await db.update(banners).set(updateData).where(eq(banners.id, Number(req.params.id))).returning();

res.json(result[0]);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.delete('/api/banners/:id', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

await db.delete(banners).where(eq(banners.id, Number(req.params.id)));

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});



// ── push-tokens-debug removed for security ──


// ── Notifications Routes ──


app.post('/api/push-token', requireAuth, async (req: any, res) => {

try {

const { token } = req.body;

if (!token) return res.status(400).json({ message: 'token مطلوب' });

await db.execute(sql`INSERT INTO push_tokens (user_id, token) VALUES (${req.user.id}, ${token}) ON CONFLICT (token) DO UPDATE SET user_id = ${req.user.id}`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.get('/api/notifications', requireAuth, async (req: any, res) => {
try {
  // ✅ FIX: الأدمن يشوف البرودكاست فقط — التاجر يشوف إشعاراته + البرودكاست
  const isAdmin = req.user.role === 'admin';
  const result = isAdmin
    ? await db.execute(sql`SELECT * FROM notifications WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 50`)
    : await db.execute(sql`SELECT * FROM notifications WHERE user_id = ${req.user.id} OR user_id IS NULL ORDER BY created_at DESC LIMIT 50`);
  res.json(result.rows);
} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});


app.patch('/api/notifications/read-all', requireAuth, async (req: any, res) => {

try {

await db.execute(sql`UPDATE notifications SET is_read = TRUE WHERE user_id = ${req.user.id}`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post('/api/notifications/broadcast', requireAuth, broadcastLimiter, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const { title, body } = req.body;

if (!title || !body) return res.status(400).json({ message: 'title و body مطلوبان' });

const { sendBroadcastNotification } = await import('./notifications');

await sendBroadcastNotification({ title, body });

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ══════════════════════════════════════════

// ── Admin Management Routes ──

// ══════════════════════════════════════════


// جلب كل الأدمنز (superAdmin فقط)

app.get('/api/admin/admins', requireAuth, async (req: any, res) => {

if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });

try {

const result = await db.execute(sql`SELECT id, store_name, phone, merchant_id, is_super_admin, permissions, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC`);

res.json(result.rows);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// إضافة أدمن جديد (superAdmin فقط)

// ترقية تاجر موجود لأدمن

app.post('/api/admin/admins', requireAuth, async (req: any, res) => {

if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });

try {

const { userId, permissions } = req.body;

if (!userId) return res.status(400).json({ message: 'userId مطلوب' });

const permsJson = JSON.stringify(permissions || []);

await db.execute(sql`UPDATE users SET role = 'admin', is_super_admin = FALSE, permissions = ${permsJson} WHERE id = ${userId} AND role = 'merchant'`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// تحويل أدمن لتاجر

app.post('/api/admin/admins/:id/demote', requireAuth, async (req: any, res) => {

if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });

try {

const adminId = Number(req.params.id);

if (adminId === req.user.id) return res.status(400).json({ message: 'لا يمكنك تحويل حسابك' });

await db.execute(sql`UPDATE users SET role = 'merchant', is_super_admin = FALSE, permissions = '[]' WHERE id = ${adminId} AND is_super_admin = FALSE`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// تعديل صلاحيات أدمن (superAdmin فقط)

app.patch('/api/admin/admins/:id', requireAuth, async (req: any, res) => {

if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });

try {

const adminId = Number(req.params.id);

const { permissions } = req.body;

const permsJson = JSON.stringify(permissions || []);

await db.execute(sql`UPDATE users SET permissions = ${permsJson} WHERE id = ${adminId} AND role = 'admin' AND is_super_admin = FALSE`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// حذف أدمن (superAdmin فقط)

app.delete('/api/admin/admins/:id', requireAuth, async (req: any, res) => {

if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });

try {

const adminId = Number(req.params.id);

if (adminId === req.user.id) return res.status(400).json({ message: 'لا يمكنك حذف حسابك' });

await db.execute(sql`DELETE FROM users WHERE id = ${adminId} AND role = 'admin' AND is_super_admin = FALSE`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ── Favorites Routes ──

app.get('/api/favorites', requireAuth, async (req: any, res) => {

try {

const favs = await storage.getFavorites(req.user.id);

const productIds = favs.map((f: any) => f.productId);

res.json(productIds);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post('/api/favorites/:productId', requireAuth, async (req: any, res) => {

try {

const productId = Number(req.params.productId);

await storage.addFavorite(req.user.id, productId);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.delete('/api/favorites/:productId', requireAuth, async (req: any, res) => {

try {

const productId = Number(req.params.productId);

await storage.removeFavorite(req.user.id, productId);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ══════════════════════════════════════════

// ── Support Chat Routes ──

// ══════════════════════════════════════════


// التاجر يجلب محادثته

app.get('/api/support/messages', requireAuth, async (req: any, res) => {

try {

const result = await db.execute(sql`

SELECT * FROM support_messages WHERE user_id = ${req.user.id}

ORDER BY created_at ASC

`);

// تحديث الرسائل كمقروءة

await db.execute(sql`

UPDATE support_messages SET is_read = TRUE

WHERE user_id = ${req.user.id} AND from_admin = TRUE AND is_read = FALSE

`);

res.json(result.rows);

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// التاجر يرسل رسالة

app.post('/api/support/messages', requireAuth, async (req: any, res) => {

try {

// التحقق من الحظر

const userResult = await db.execute(sql`SELECT support_blocked FROM users WHERE id = ${req.user.id}`);

const isBlocked = (userResult.rows[0] as any)?.support_blocked;

if (isBlocked) return res.status(403).json({ message: 'تم حظرك من إرسال الرسائل' });


const { message, imageUrl } = req.body;

if (!message?.trim() && !imageUrl) return res.status(400).json({ message: 'الرسالة فارغة' });


// فلترة الكلمات المسيئة

const BAD_WORDS = ['كلب', 'حمار', 'غبي', 'احمق', 'خنزير', 'عاهرة', 'شرموطة', 'منيوك', 'ابن الكلب'];

let filteredMsg = (message || '').trim();

for (const word of BAD_WORDS) {

filteredMsg = filteredMsg.replace(new RegExp(word, 'gi'), '***');

}


await db.execute(sql`

INSERT INTO support_messages (user_id, from_admin, message, image_url)

VALUES (${req.user.id}, FALSE, ${filteredMsg}, ${imageUrl || null})

`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// الأدمن يجلب كل المحادثات

app.get('/api/admin/support', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const result = await db.execute(sql`

SELECT sm.*, u.store_name, u.phone, u.support_blocked

FROM support_messages sm

JOIN users u ON u.id = sm.user_id

ORDER BY sm.created_at ASC

`);

// تجميع المحادثات حسب المستخدم

const map: Record<number, any> = {};

for (const row of result.rows as any[]) {

if (!map[row.user_id]) {

map[row.user_id] = {

userId: row.user_id,

storeName: row.store_name,

phone: row.phone,

isBlocked: row.support_blocked,

messages: [],

unread: 0,

};

}

map[row.user_id].messages.push(row);

map[row.user_id].isBlocked = row.support_blocked;

if (!row.from_admin && !row.is_read) map[row.user_id].unread++;

}

// ترتيب: الأحدث أعلى (آخر رسالة)

res.json(Object.values(map).sort((a: any, b: any) => {

const aLast = a.messages[a.messages.length - 1]?.created_at || 0;

const bLast = b.messages[b.messages.length - 1]?.created_at || 0;

return new Date(bLast).getTime() - new Date(aLast).getTime();

}));

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// الأدمن يرد على محادثة تاجر

app.post('/api/admin/support/:userId', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const userId = Number(req.params.userId);

const { message, imageUrl } = req.body;

if (!message?.trim() && !imageUrl) return res.status(400).json({ message: 'الرسالة فارغة' });

const msgText = message?.trim() || '';

await db.execute(sql`

INSERT INTO support_messages (user_id, from_admin, message, image_url)

VALUES (${userId}, TRUE, ${msgText}, ${imageUrl || null})

`);

// إرسال push notification للتاجر

try {

const { sendPushNotification } = await import('./notifications');

const notifBody = msgText || '📷 صورة';

await sendPushNotification({

userIds: [userId],

title: 'رسالة جديدة من الدعم',

body: notifBody.substring(0, 80),

data: { type: 'support_message' },

});

} catch (_) {}

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// عدد الرسائل غير المقروءة للتاجر

app.get('/api/support/unread', requireAuth, async (req: any, res) => {

try {

const result = await db.execute(sql`

SELECT COUNT(*) as count FROM support_messages

WHERE user_id = ${req.user.id} AND from_admin = TRUE AND is_read = FALSE

`);

res.json({ count: Number((result.rows[0] as any)?.count || 0) });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// حظر/فك حظر تاجر من الشات

// تصفير عداد الرسائل الغير مقروءة من الأدمن

app.post('/api/admin/support/:userId/read', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const userId = Number(req.params.userId);

await db.execute(sql`

UPDATE support_messages SET is_read = TRUE

WHERE user_id = ${userId} AND from_admin = FALSE AND is_read = FALSE

`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


app.post('/api/admin/support/:userId/block', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const userId = Number(req.params.userId);

const { block } = req.body;

await db.execute(sql`UPDATE users SET support_blocked = ${block} WHERE id = ${userId}`);

res.json({ success: true });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// رفع صورة للشات عبر Cloudinary

app.post('/api/support/upload-image', requireAuth, async (req: any, res) => {

try {

const { imageBase64 } = req.body;

if (!imageBase64) return res.status(400).json({ message: 'لا توجد صورة' });

// ✅ Fix: حد حجم الصورة 5MB
const base64SizeBytes = Buffer.byteLength(imageBase64, 'base64');
if (base64SizeBytes > 5 * 1024 * 1024) {
  return res.status(400).json({ message: 'حجم الصورة يجب أن لا يتجاوز 5MB' });
}

const { v2: cloudinary } = await import('cloudinary');

cloudinary.config({

cloud_name: process.env.CLOUDINARY_CLOUD_NAME,

api_key: process.env.CLOUDINARY_API_KEY,

api_secret: process.env.CLOUDINARY_API_SECRET,

});

const result = await cloudinary.uploader.upload(imageBase64, {

folder: 'support',

transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto' }],

});

res.json({ url: result.secure_url });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ── Stats endpoint مخصص ──

app.get('/api/admin/stats-data', requireAuth, async (req: any, res) => {

if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });

try {

const [orders, withdrawals, products] = await Promise.all([

storage.getOrders(undefined),

storage.getWithdrawals(),

storage.getProducts(),

]);

const usersResult = await db.execute(sql`SELECT id, store_name, phone, merchant_id, role, balance, pending_balance, is_active, created_at FROM users`);
  const users = usersResult.rows;

res.json({ orders, users, withdrawals, products });

} catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }

});


// ══════════════════════════════════════════

// ── Delete Account (User self-delete) ──

// ══════════════════════════════════════════

app.delete("/api/auth/delete-account", requireAuth, async (req: any, res) => {

try {

const userId = req.user.id;

const user = await storage.getUser(userId);

if (!user) {

return res.status(404).json({ message: "المستخدم غير موجود" });

}

// حذف الطلبات

await db.delete(orders).where(eq(orders.merchantId, userId));

// حذف طلبات السحب

await db.delete(withdrawals).where(eq(withdrawals.merchantId, userId));

// حذف المفضلة

await db.delete(favorites).where(eq(favorites.userId, userId));

// حذف الإشعارات

await db.delete(notifications).where(eq(notifications.userId, userId));

// حذف رسائل الدعم

await db.delete(supportMessages).where(eq(supportMessages.userId, userId));

// حذف التوكنات

await db.delete(pushTokens).where(eq(pushTokens.userId, userId));

// حذف المستخدم نفسه

await storage.deleteUser(userId);

console.log(`✅ User ${userId} deleted their account`);

res.json({ message: "تم حذف الحساب بنجاح" });

} catch (e: any) {

console.error("Delete account error:", e);

res.status(500).json({ message: "حدث خطأ في الخادم" });

}

});


// ── Migration: جدول الفئات ──
try {
  await db.execute(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    icon TEXT NOT NULL DEFAULT 'grid-outline',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  // إضافة فئات افتراضية إذا الجدول فارغ
  const existing = await db.execute(`SELECT COUNT(*) as count FROM categories`);
  const count = Number((existing.rows[0] as any)?.count || 0);
  if (count === 0) {
    await db.execute(`INSERT INTO categories (name, icon, sort_order) VALUES
      ('إلكترونيات', 'phone-portrait-outline', 1),
      ('أجهزة منزلية', 'home-outline', 2),
      ('اكسسوارات نسائية', 'rose-outline', 3),
      ('منوعات', 'grid-outline', 4)
    `);
  }
  console.log('✅ Categories migration done');
} catch (e) { console.log('Categories migration note:', e); }

// ══════════════════════════════════════════
// ── Categories Routes ──
// ══════════════════════════════════════════

// جلب كل الفئات النشطة (للتجار والأدمن)
app.get('/api/categories', async (_req, res) => {
  try {
    const result = await db.select().from(categories)
      .orderBy(categories.sortOrder);
    res.json(result);
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});

// جلب "الأكثر مبيعاً" — أعلى 10 منتجات بالمبيعات
app.get('/api/categories/best-sellers', async (_req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT p.id, p.name, p.category, SUM(oi.quantity) as total_sold
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('delivered')
        AND p.is_active = TRUE
        AND p.stock > 0
      GROUP BY p.id, p.name, p.category
      ORDER BY total_sold DESC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});

// إضافة فئة (أدمن فقط)
app.post('/api/categories', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    const { name, icon, sortOrder } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: 'اسم الفئة مطلوب' });
    const result = await db.insert(categories).values({
      name: name.trim(),
      icon: icon || 'grid-outline',
      sortOrder: Number(sortOrder) || 0,
    }).returning();
    res.status(201).json(result[0]);
  } catch (e: any) {
    if (e.message?.includes('unique')) return res.status(400).json({ message: 'هذه الفئة موجودة مسبقاً' });
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// تعديل فئة (أدمن فقط)
app.patch('/api/categories/:id', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    const { name, icon, sortOrder, isActive } = req.body;

    // ✅ لو تغير الاسم — حدّث المنتجات أيضاً
    if (name !== undefined) {
      const oldCat = await db.select({ name: categories.name })
        .from(categories).where(eq(categories.id, Number(req.params.id))).limit(1);
      const oldName = oldCat[0]?.name;

      if (oldName && oldName !== name.trim()) {
        const prods = await db.select({ id: products.id, category: products.category })
          .from(products)
          .where(sql`category LIKE ${'%' + oldName + '%'}`);

        for (const p of prods) {
          const updated = (p.category || '')
            .split(',')
            .map((c: string) => c.trim() === oldName ? name.trim() : c.trim())
            .join(',');
          await db.update(products).set({ category: updated }).where(eq(products.id, p.id));
        }
      }
    }

    const update: any = {};
    if (name      !== undefined) update.name      = name.trim();
    if (icon      !== undefined) update.icon      = icon;
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder);
    if (isActive  !== undefined) update.isActive  = Boolean(isActive);
    const result = await db.update(categories).set(update)
      .where(eq(categories.id, Number(req.params.id))).returning();
    res.json(result[0]);
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});

// حذف فئة (أدمن فقط)
app.delete('/api/categories/:id', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    // ✅ جلب اسم الفئة قبل الحذف
    const catResult = await db.select().from(categories)
      .where(eq(categories.id, Number(req.params.id))).limit(1);
    const catName = catResult[0]?.name;

    if (catName) {
      // ✅ إزالة اسم الفئة من كل المنتجات — المنتج لا يُحذف
      const prods = await db.select({ id: products.id, category: products.category })
        .from(products)
        .where(sql`category LIKE ${'%' + catName + '%'}`);

      for (const p of prods) {
        const updated = (p.category || '')
          .split(',')
          .map((c: string) => c.trim())
          .filter((c: string) => c !== catName)
          .join(',') || 'عام';
        await db.update(products).set({ category: updated }).where(eq(products.id, p.id));
      }
    }

    // ✅ حذف الفئة
    await db.delete(categories).where(eq(categories.id, Number(req.params.id)));
    res.json({ success: true, affectedProducts: catName ? 0 : 0 });
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});



// ══════════════════════════════════════════
// ── Inventory Routes ──
// ══════════════════════════════════════════

// Migration جدول السجل
try {
  await db.execute(`CREATE TABLE IF NOT EXISTS inventory_log (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    admin_id INTEGER,
    change INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    stock_after INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
} catch (e) { console.log('inventory_log migration:', e); }

// ── جلب المخزون الكامل ──
app.get('/api/inventory', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    const filter = req.query.filter as string; // low | out | stale | all
    let prods = await storage.getProducts();

    if (filter === 'low')  prods = prods.filter((p: any) => p.stock > 0 && p.stock <= 10);
    if (filter === 'out')  prods = prods.filter((p: any) => p.stock === 0);
    if (filter === 'stale') {
      // منتجات ما بيعت 30 يوم
      const staleResult = await db.execute(sql`
        SELECT DISTINCT product_id FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at > NOW() - INTERVAL '30 days'
      `);
      const activeIds = new Set((staleResult.rows as any[]).map((r: any) => r.product_id));
      prods = prods.filter((p: any) => !activeIds.has(p.id) && p.stock > 0);
    }

    // أضف إحصائيات لكل منتج
    const enriched = await Promise.all(prods.map(async (p: any) => {
      const sales = await db.execute(sql`
        SELECT COALESCE(SUM(oi.quantity), 0) as total_sold
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = ${p.id} AND o.status = 'delivered'
      `);
      return { ...p, totalSold: Number((sales.rows[0] as any)?.total_sold || 0) };
    }));

    res.json(enriched);
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});

// ── تعديل مخزون منتج يدوياً ──
app.patch('/api/inventory/:productId', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    const { change, note, reason = 'manual' } = req.body;
    const productId = Number(req.params.productId);

    if (!change || isNaN(Number(change))) return res.status(400).json({ message: 'قيمة التغيير مطلوبة' });

    const product = await storage.getProduct(productId);
    if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });

    const newStock = Math.max(0, product.stock + Number(change));
    await storage.updateProduct(productId, { stock: newStock });

    // سجّل في inventory_log
    await db.insert(inventoryLog).values({
      productId, adminId: req.user.id,
      change: Number(change), reason, note: note || null,
      stockAfter: newStock,
    });

    // إشعار للأدمن لو نفد المخزون
    if (newStock === 0) {
      try {
        const adminUsers = await db.execute(sql`SELECT id FROM users WHERE role = 'admin'`);
        const adminIds = (adminUsers.rows as any[]).map((u: any) => u.id);
        const { sendPushNotification } = await import('./notifications');
        await sendPushNotification({
          userIds: adminIds,
          title: '⚠️ نفد المخزون',
          body: `المنتج "${product.name}" نفد المخزون بالكامل`,
          data: { type: 'stock_out', productId: String(productId) },
        });
      } catch (_) {}
    }

    res.json({ stock: newStock, change: Number(change) });
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});

// ── سجل تغييرات مخزون منتج ──
app.get('/api/inventory/:productId/log', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    const result = await db.execute(sql`
      SELECT il.*, p.name as product_name, u.store_name as admin_name
      FROM inventory_log il
      LEFT JOIN products p ON p.id = il.product_id
      LEFT JOIN users u ON u.id = il.admin_id
      WHERE il.product_id = ${Number(req.params.productId)}
      ORDER BY il.created_at DESC LIMIT 50
    `);
    res.json(result.rows);
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});

// ── إحصائيات المخزون العامة ──
app.get('/api/inventory/stats', requireAuth, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
  try {
    const prods = await storage.getProducts();
    const total     = prods.length;
    const outOfStock = prods.filter((p: any) => p.stock === 0).length;
    const lowStock   = prods.filter((p: any) => p.stock > 0 && p.stock <= 10).length;
    const totalValue = prods.reduce((s: number, p: any) => s + (p.wholesalePrice * p.stock), 0);

    const staleResult = await db.execute(sql`
      SELECT DISTINCT product_id FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at > NOW() - INTERVAL '30 days'
    `);
    const activeIds = new Set((staleResult.rows as any[]).map((r: any) => r.product_id));
    const stale = prods.filter((p: any) => !activeIds.has(p.id) && p.stock > 0).length;

    res.json({ total, outOfStock, lowStock, stale, totalValue });
  } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
});



return httpServer;


}