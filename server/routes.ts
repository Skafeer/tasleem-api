import { saqrAssistant } from "./saqrService";
import { tariqAssistant } from "./tariqService";
import { Express, Request, Response } from "express";
import { Server } from "http";
import { setupAuth, requireAuth } from "./auth";
const saqrLimiter  = rateLimit(10, 60_000);
const tariqLimiter = rateLimit(20, 60_000);

function sanitizeUser(user: any, isAdmin = false) {
  if (!user) return null;
  const { password, ...safe } = user;
  if (!isAdmin) {
    const { companyWholesalePrice, isSuperAdmin, is_super_admin, permissions, ...merchant } = safe;
    return merchant;
  }
  return safe;
}

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
import {
  promoCodes, promoUsages, products, orders, orderItems, banners, withdrawals,
  favorites, notifications, pushTokens, supportMessages, categories, inventoryLog,
  stores, storeProducts,
} from "@shared/schema";
import { eq, sql, and, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";

// ── Campaigns Service ──
import {
  countOrderInCampaigns,
  rejectOrderInCampaigns,
  startCampaignCron,
  distributeCampaignRewards,
} from "./campaigns";

// ── Store Utilities ──
import { generateUniqueStoreCode } from "./utils/generateCode";

// ── Rate Limiter ──
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

const authLimiter = rateLimit(10, 60_000);
const generalLimiter = rateLimit(100, 60_000);
const broadcastLimiter = rateLimit(5, 60_000);
const storePublicLimiter = rateLimit(200, 60_000);

const hasPermission = (user: any, perm: string): boolean => {
  if (user.role !== 'admin') return false;
  if (user.isSuperAdmin || user.is_super_admin) return true;
  try {
    const perms: string[] = JSON.parse(user.permissions || '[]');
    return perms.includes(perm);
  } catch { return false; }
};

// ══════════════════════════════════════════════════════════════════
// ── Promo Code Validation Helper ──
// ══════════════════════════════════════════════════════════════════
interface PromoValidationResult {
  valid: boolean;
  error?: string;
  discount?: number;
  promo?: any;
}

interface PromoContext {
  cartAmount: number;
  shippingCost: number;
}

async function validatePromoCode(
  code: string,
  userId: number,
  context: PromoContext
): Promise<PromoValidationResult> {
  const { cartAmount, shippingCost } = context;

  const promo = await storage.getPromoCodeByCode(code);
  if (!promo) {
    return { valid: false, error: 'الكود غير صحيح' };
  }

  if (!promo.isActive) {
    return { valid: false, error: 'هذا الكود غير مفعّل حالياً' };
  }

  const now = new Date();
  if (promo.startsAt && new Date(promo.startsAt) > now) {
    return { valid: false, error: 'هذا الكود لم يبدأ بعد' };
  }
  if (promo.expiresAt && new Date(promo.expiresAt) < now) {
    return { valid: false, error: 'انتهت صلاحية هذا الكود' };
  }

  if (promo.minCartAmount > 0 && cartAmount < promo.minCartAmount) {
    return {
      valid: false,
      error: `الحد الأدنى للطلب ${promo.minCartAmount.toLocaleString()} د.ع`,
    };
  }

  if (promo.targetType === 'specific') {
    const allowedIds = (promo.targetUserIds || '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (!allowedIds.includes(userId)) {
      return { valid: false, error: 'هذا الكود غير متاح لحسابك' };
    }
  }

  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
    return { valid: false, error: 'تم استهلاك هذا الكود بالكامل' };
  }

  if (promo.maxUsesPerUser > 0) {
    const userUsage = await storage.getUserPromoUsageCount(promo.id, userId);
    if (userUsage >= promo.maxUsesPerUser) {
      return {
        valid: false,
        error: promo.maxUsesPerUser === 1
          ? 'استخدمت هذا الكود من قبل'
          : `استخدمت هذا الكود ${promo.maxUsesPerUser} مرات كحد أقصى`,
      };
    }
  }

  const appliesTo = (promo as any).appliesTo || 'subtotal';
  const baseAmount = appliesTo === 'shipping' ? shippingCost : cartAmount;

  if (appliesTo === 'shipping' && shippingCost <= 0) {
    return { valid: false, error: 'لا يوجد توصيل لتطبيق الخصم عليه' };
  }

  let discount = 0;
  if (promo.discountType === 'percentage') {
    discount = (baseAmount * promo.discountPercent) / 100;
  } else {
    discount = promo.discountAmount;
  }

  if (promo.maxDiscount > 0 && discount > promo.maxDiscount) {
    discount = promo.maxDiscount;
  }

  discount = Math.min(discount, baseAmount);
  discount = Math.round(discount);

  return { valid: true, discount, promo };
}

// ══════════════════════════════════════════════════════════════════
// ── Store: الألوان المسموحة ──
// ══════════════════════════════════════════════════════════════════
const ALLOWED_STORE_COLORS = [
  'primary',   // #0c6679
  'emerald',   // #10b981
  'blue',      // #3b82f6
  'purple',    // #8b5cf6
  'rose',      // #f43f5e
  'amber',     // #f59e0b
  'orange',    // #f97316
  'teal',      // #14b8a6
  'indigo',    // #6366f1
  'pink',      // #ec4899
  'cyan',      // #06b6d4
  'slate',     // #475569
];

const STORE_PHONE_REGEX = /^07[0-9]{9}$/;
const STORE_PROVINCES = [
  'بغداد', 'البصرة', 'نينوى', 'الأنبار', 'كربلاء', 'النجف',
  'ذي قار', 'القادسية', 'بابل', 'ديالى', 'ميسان', 'واسط',
  'صلاح الدين', 'المثنى', 'كركوك', 'دهوك', 'أربيل', 'السليمانية'
];

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

  // ── Tariq AI Assistant ──
  app.post("/api/tariq/chat", requireAuth, tariqLimiter, async (req: any, res) => {
    try {
      const { messages } = req.body;
      if (!messages || !Array.isArray(messages) || messages.length === 0)
        return res.status(400).json({ message: "يرجى إرسال المحادثة" });
      if (messages.length > 40)
        return res.status(400).json({ message: "المحادثة طويلة جداً، ابدأ محادثة جديدة" });
      const validRoles = ["user", "model"];
      const isValid = messages.every((m: any) =>
        validRoles.includes(m.role) &&
        Array.isArray(m.parts) &&
        m.parts.length > 0 &&
        typeof m.parts[0]?.text === "string" &&
        m.parts[0].text.trim().length > 0 &&
        m.parts[0].text.length <= 1000
      );
      if (!isValid)
        return res.status(400).json({ message: "صيغة الرسائل غير صحيحة" });
      const reply = await tariqAssistant.chat(messages, req.user.id);
      res.json({ reply });
    } catch (e) {
      console.error("Tariq route error:", e);
      res.status(500).json({ message: "حدث خطأ في استدعاء طارق" });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Migrations ──
  // ══════════════════════════════════════════════════════════════════
  try {
    await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT NOT NULL DEFAULT '[]'`);
    await db.execute(`UPDATE users SET is_super_admin = TRUE WHERE role = 'admin' AND (is_super_admin IS NULL OR is_super_admin = FALSE) AND id = (SELECT MIN(id) FROM users WHERE role = 'admin')`);
    console.log('✅ Admin permissions migration done');
  } catch (e) { console.log('Migration note:', e); }

  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS backup_phone TEXT`);
    console.log('✅ backup_phone column added to orders');
  } catch (e) { console.log('backup_phone migration note:', e); }

  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
    console.log('✅ delivered_at column added to orders');
  } catch (e) { console.log('delivered_at migration note:', e); }

  // ✅ Migration: عمودي المتجر في الطلبات
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app'`);
    await db.execute(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INTEGER`);
    console.log('✅ source + store_id columns added to orders');
  } catch (e) { console.log('orders store columns migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, product_id)
    )`);
    console.log('✅ Favorites migration done');
  } catch (e) { console.log('Favorites migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, from_admin BOOLEAN NOT NULL DEFAULT FALSE,
      message TEXT NOT NULL, is_read BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ Support messages migration done');
  } catch (e) { console.log('Support migration note:', e); }

  try {
    await db.execute(`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await db.execute(`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS support_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log('✅ Support updates migration done');
  } catch (e) { console.log('Support updates migration note:', e); }

  // ══════════════════════════════════════════════════════════════════
  // ── Promo Codes Migrations ──
  // ══════════════════════════════════════════════════════════════════
  try {
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'percentage'`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS discount_amount REAL NOT NULL DEFAULT 0`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_discount REAL NOT NULL DEFAULT 0`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'subtotal'`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'all'`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS target_user_ids TEXT NOT NULL DEFAULT ''`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS min_cart_amount REAL NOT NULL DEFAULT 0`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS starts_at TIMESTAMP`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_uses INTEGER NOT NULL DEFAULT 0`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_uses_per_user INTEGER NOT NULL DEFAULT 1`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0`);
    await db.execute(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    console.log('✅ Promo codes columns migration done');
  } catch (e) { console.log('promo_codes columns migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS promo_usages (
      id SERIAL PRIMARY KEY,
      promo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      discount_amount REAL NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ promo_usages migration done');
  } catch (e) { console.log('promo_usages migration note:', e); }

  // ══════════════════════════════════════════════════════════════════
  // ── Campaigns Migrations ──
  // ══════════════════════════════════════════════════════════════════
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      product_id INTEGER NOT NULL,
      target_count INTEGER NOT NULL,
      starts_at TIMESTAMP NOT NULL,
      ends_at TIMESTAMP NOT NULL,
      reward_type TEXT NOT NULL,
      reward_value REAL NOT NULL DEFAULT 0,
      reward_data TEXT NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_distributed BOOLEAN NOT NULL DEFAULT FALSE,
      distributed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ campaigns migration done');
  } catch (e) { console.log('campaigns migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS campaign_participants (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      progress_count INTEGER NOT NULL DEFAULT 0,
      target_reached BOOLEAN NOT NULL DEFAULT FALSE,
      target_reached_at TIMESTAMP,
      reward_claimed BOOLEAN NOT NULL DEFAULT FALSE,
      reward_claimed_at TIMESTAMP,
      joined_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ campaign_participants migration done');
  } catch (e) { console.log('campaign_participants migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS campaign_orders (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'counted',
      delivered_at TIMESTAMP,
      counted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ campaign_orders migration done');
  } catch (e) { console.log('campaign_orders migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS campaign_rewards (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reward_type TEXT NOT NULL,
      cash_amount REAL NOT NULL DEFAULT 0,
      code TEXT,
      value REAL NOT NULL DEFAULT 0,
      applies_to TEXT NOT NULL DEFAULT 'shipping',
      expires_at TIMESTAMP,
      used_at TIMESTAMP,
      used_order_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ campaign_rewards migration done');
  } catch (e) { console.log('campaign_rewards migration note:', e); }

  // ══════════════════════════════════════════════════════════════════
  // ── Stores Migrations ──
  // ══════════════════════════════════════════════════════════════════
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,
      instagram TEXT NOT NULL DEFAULT '',
      facebook TEXT NOT NULL DEFAULT '',
      tiktok TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'primary',
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ stores migration done');
  } catch (e) { console.log('stores migration note:', e); }

  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS store_products (
      id SERIAL PRIMARY KEY,
      store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      price REAL NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(store_id, product_id)
    )`);
    console.log('✅ store_products migration done');
  } catch (e) { console.log('store_products migration note:', e); }

  // ══════════════════════════════════════════════════════════════════
  // ── Products ──
  // ══════════════════════════════════════════════════════════════════
  app.get("/api/products", async (req: any, res) => {
    try {
      const all = await storage.getProducts();
      const activeOnly = req.query.activeOnly === 'true';
      res.json(activeOnly ? all.filter((p: any) => p.isActive !== false) : all);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.get("/api/products/all", requireAuth, async (req: any, res) => {
    try {
      const all = await storage.getProducts();
      res.json(all);
    } catch (e: any) {
      console.error("Error getting all products:", e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
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

  // ══════════════════════════════════════════════════════════════════
  // ── Orders ──
  // ══════════════════════════════════════════════════════════════════
  app.get("/api/orders", requireAuth, async (req: any, res) => {
    try {
      let merchantId: number | undefined;
      if (req.user.role === 'admin') {
        merchantId = req.query.merchantId ? Number(req.query.merchantId) : undefined;
      } else {
        merchantId = req.user.id;
      }
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Number(req.query.limit) || 20);
      const status = req.query.status as string | undefined;
      const search = req.query.search as string | undefined;
      const offset = (page - 1) * limit;

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
        data, page, limit, total,
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

  // ══════════════════════════════════════════════════════════════════
  // ── POST /api/orders ──
  // ══════════════════════════════════════════════════════════════════
  app.post("/api/orders", requireAuth, generalLimiter, async (req: any, res) => {
    try {
      const { items, customerName, customerPhone, province, address, notes, promoCode, backupPhone } = req.body;

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
        if (price < product.sellingPriceMin) {
          throw new Error(`سعر البيع أقل من الحد الأدنى المسموح (${product.sellingPriceMin})`);
        }
        totalAmount += price * qty;
        totalCost += product.wholesalePrice * qty;
        totalCompanyCost += (product.companyWholesalePrice || 0) * qty;
        return { productId: Number(item.productId), quantity: qty, price, cost: product.wholesalePrice };
      }));

      const companyMarginBeforeDiscount = totalCost - totalCompanyCost;

      const isBasra = province.includes("البصرة");
      const shippingCost = isBasra ? 3000 : 5000;
      const rawSubsidy = Number(req.body.shippingSubsidy || 0);
      const shippingSubsidy = Math.max(0, Math.min(rawSubsidy, shippingCost));
      const baseCustomerShipping = shippingCost - shippingSubsidy;

      let productsDiscount = 0;
      let shippingDiscount = 0;
      let validPromo = "";
      let appliedPromo: any = null;

      if (promoCode && promoCode.trim()) {
        const result = await validatePromoCode(
          promoCode.trim().toUpperCase(),
          req.user.id,
          { cartAmount: totalAmount, shippingCost: baseCustomerShipping }
        );

        if (!result.valid) {
          return res.status(400).json({ message: result.error });
        }

        const appliesTo = result.promo.appliesTo || 'subtotal';
        if (appliesTo === 'shipping') {
          shippingDiscount = result.discount || 0;
        } else {
          productsDiscount = result.discount || 0;
        }
        validPromo = result.promo.code;
        appliedPromo = result.promo;
      }

      if (productsDiscount > companyMarginBeforeDiscount) {
        return res.status(400).json({
          message: `قيمة الخصم (${productsDiscount.toLocaleString()} د.ع) تتجاوز الحد المتاح لهذا الطلب. الحد الأقصى: ${companyMarginBeforeDiscount.toLocaleString()} د.ع`,
        });
      }

      const totalPromoDiscount = productsDiscount + shippingDiscount;
      const customerShipping = Math.max(0, baseCustomerShipping - shippingDiscount);

      const totalProfit = totalAmount - totalCost - shippingSubsidy;
      const companyProfit = companyMarginBeforeDiscount - productsDiscount - shippingDiscount;
      const finalAmount = totalAmount + customerShipping - productsDiscount;

      const order = await storage.createOrder({
        merchantId: req.user.id,
        customerName, customerPhone, province, address,
        backupPhone: backupPhone || null,
        notes: notes || "",
        status: "processing",
        totalAmount: finalAmount,
        shippingCost: customerShipping,
        totalProfit,
        companyProfit,
        promoCode: validPromo,
        promoDiscount: totalPromoDiscount,
        source: 'app',
      }, enrichedItems);

      if (appliedPromo && order) {
        try {
          await storage.createPromoUsage({
            promoId: appliedPromo.id,
            userId: req.user.id,
            orderId: order.id,
            discountAmount: totalPromoDiscount,
          });
          await storage.incrementPromoUsedCount(appliedPromo.id);
        } catch (err) {
          console.error('Failed to record promo usage:', err);
        }
      }

      await Promise.all(enrichedItems.map(async (item: any) => {
        const product = await storage.getProduct(item.productId);
        if (product) {
          const newStock = Math.max(0, product.stock - item.quantity);
          await storage.updateProduct(item.productId, { stock: newStock });
          await db.insert(inventoryLog).values({
            productId: item.productId, adminId: null,
            change: -item.quantity, reason: 'order',
            note: `طلب #${order?.id}`, stockAfter: newStock,
          }).catch(() => {});
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

      const freshUser = await storage.getUser(req.user.id);
      if (freshUser) {
        await storage.updateUser(req.user.id, {
          pendingBalance: (freshUser.pendingBalance || 0) + totalProfit,
        });
      }

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
    } catch (e: any) {
      console.error('Create order error:', e);
      res.status(500).json({ message: e.message || 'حدث خطأ في الخادم' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── تحديث حالة الطلب ──
  // ══════════════════════════════════════════════════════════════════
  app.patch("/api/orders/:id/status", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin" && req.user.role !== "merchant") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      const VALID_STATUSES = ['processing', 'shipping', 'delivered', 'cancelled', 'returned', 'postponed'];
      if (!VALID_STATUSES.includes(req.body.status))
        return res.status(400).json({ message: 'حالة غير صحيحة' });

      const order = await storage.getOrder(Number(req.params.id));
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

      if (req.user.role === "merchant") {
        if (order.merchantId !== req.user.id) return res.status(403).json({ message: "ليس طلبك" });
        if (req.body.status !== "cancelled") return res.status(403).json({ message: "يمكنك فقط إلغاء الطلب" });
        if (order.status !== "processing") return res.status(400).json({ message: "لا يمكن إلغاء هذا الطلب في مرحلته الحالية" });
      }

      const PENDING_STATUSES = ['processing', 'shipping', 'postponed'];
      const BALANCE_STATUSES = ['delivered'];
      const LOSS_STATUSES = ['cancelled', 'returned'];

      const oldStatus = order.status;
      const newStatus = req.body.status;
      const oldWasPending = PENDING_STATUSES.includes(oldStatus);
      const oldWasBalance = BALANCE_STATUSES.includes(oldStatus);
      const oldWasLoss = LOSS_STATUSES.includes(oldStatus);
      const newIsPending = PENDING_STATUSES.includes(newStatus);
      const newIsBalance = BALANCE_STATUSES.includes(newStatus);
      const newIsLoss = LOSS_STATUSES.includes(newStatus);

      if (oldWasPending && newIsLoss) {
        await db.execute(sql`UPDATE users SET pending_balance = GREATEST(0, pending_balance - ${order.totalProfit}) WHERE id = ${order.merchantId}`);
      } else if (oldWasLoss && newIsPending) {
        await db.execute(sql`UPDATE users SET pending_balance = pending_balance + ${order.totalProfit} WHERE id = ${order.merchantId}`);
      } else if (oldWasPending && newIsBalance) {
        await db.execute(sql`UPDATE users SET pending_balance = GREATEST(0, pending_balance - ${order.totalProfit}), balance = balance + ${order.totalProfit} WHERE id = ${order.merchantId}`);
      } else if (oldWasBalance && newIsPending) {
        await db.execute(sql`UPDATE users SET balance = GREATEST(0, balance - ${order.totalProfit}), pending_balance = pending_balance + ${order.totalProfit} WHERE id = ${order.merchantId}`);
      } else if (oldWasBalance && newIsLoss) {
        await db.execute(sql`UPDATE users SET balance = GREATEST(0, balance - ${order.totalProfit}) WHERE id = ${order.merchantId}`);
      } else if (oldWasLoss && newIsBalance) {
        await db.execute(sql`UPDATE users SET balance = balance + ${order.totalProfit} WHERE id = ${order.merchantId}`);
      }

      const updated = await storage.updateOrder(Number(req.params.id), { status: newStatus });

      if (newIsBalance && !order.deliveredAt) {
        await db.execute(sql`UPDATE orders SET delivered_at = NOW() WHERE id = ${order.id} AND delivered_at IS NULL`);
      }

      const TERMINAL_STATUSES = ['cancelled', 'returned'];
      const wasTerminal = TERMINAL_STATUSES.includes(oldStatus);
      const isTerminal = TERMINAL_STATUSES.includes(newStatus);
      const shouldRestoreStock = isTerminal && !wasTerminal;
      const shouldDeductStock = !isTerminal && wasTerminal;

      if (shouldRestoreStock || shouldDeductStock) {
        const fullOrder = await storage.getOrder(order.id);
        if (fullOrder?.items) {
          await Promise.all(fullOrder.items.map(async (item: any) => {
            const product = await storage.getProduct(item.productId);
            if (!product) return;
            const change = shouldRestoreStock ? item.quantity : -item.quantity;
            const newStock = Math.max(0, product.stock + change);
            await storage.updateProduct(item.productId, { stock: newStock });
            await db.insert(inventoryLog).values({
              productId: item.productId, adminId: req.user.id, change,
              reason: shouldRestoreStock ? (newStatus === 'cancelled' ? 'cancel' : 'returned') : 'order',
              note: shouldRestoreStock ? `طلب #${order.id} — ${newStatus === 'cancelled' ? 'ملغي' : 'مرتجع'}` : `طلب #${order.id} — إعادة تفعيل من ${oldStatus}`,
              stockAfter: newStock,
            }).catch(() => {});
          }));
        }
      }

      if (order.promoCode && isTerminal && !wasTerminal) {
        try {
          const promo = await storage.getPromoCodeByCode(order.promoCode);
          if (promo) {
            await storage.decrementPromoUsedCount(promo.id);
            await storage.deletePromoUsageByOrder(order.id);
          }
        } catch (_) {}
      }

      try {
        if (newIsBalance) {
          await countOrderInCampaigns(order.id);
        } else if (newIsLoss) {
          await rejectOrderInCampaigns(order.id);
        }
      } catch (err) {
        console.error('Campaign sync error:', err);
      }

      const STATUS_LABELS: Record<string, string> = {
        processing: 'قيد المعالجة 🔄',
        shipping: 'قيد التوصيل 🚴',
        delivered: 'تم التوصيل ✅',
        cancelled: 'تم الإلغاء ❌',
        returned: 'تم الرفض ⛔',
        postponed: 'مؤجل ⏸',
      };

      try {
        const { sendPushNotification } = await import('./notifications');
        await sendPushNotification({
          userIds: [order.merchantId],
          title: 'تحديث حالة الطلب',
          body: `طلبك رقم #${order.id} أصبح: ${STATUS_LABELS[newStatus] || newStatus}`,
          data: { type: 'order_status', orderId: order.id, status: newStatus },
        });
      } catch (_) {}

      res.json(updated);
    } catch (e: any) {
      console.error("Error updating order status:", e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── Edit Order (Admin) ──
  app.put("/api/orders/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const orderId = Number(req.params.id);
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
      const { customerName, customerPhone, province, address, notes, items, backupPhone } = req.body;
      let updateData: any = {};
      if (customerName !== undefined) updateData.customerName = customerName;
      if (customerPhone !== undefined) updateData.customerPhone = customerPhone;
      if (backupPhone !== undefined) updateData.backupPhone = backupPhone;
      if (province !== undefined) updateData.province = province;
      if (address !== undefined) updateData.address = address;
      if (notes !== undefined) updateData.notes = notes;
      if (items && Array.isArray(items)) {
        await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
        let totalAmount = 0, totalCost = 0, totalCompanyCost = 0;
        const enriched = await Promise.all(items.map(async (item: any) => {
          const product = await storage.getProduct(Number(item.productId));
          if (!product) throw new Error("منتج غير موجود");
          const qty = Number(item.quantity);
          const price = Number(item.price);
          totalAmount += price * qty;
          totalCost += product.wholesalePrice * qty;
          totalCompanyCost += (product.companyWholesalePrice || 0) * qty;
          return { orderId, productId: Number(item.productId), quantity: qty, price, cost: product.wholesalePrice };
        }));
        await db.insert(orderItems).values(enriched);
        const shippingCost = order.shippingCost || 5000;
        const promoDiscount = order.promoDiscount || 0;
        const companyMarginBeforeDiscount = totalCost - totalCompanyCost;

        updateData.totalAmount = totalAmount + shippingCost - promoDiscount;
        updateData.totalProfit = totalAmount - totalCost;
        updateData.companyProfit = companyMarginBeforeDiscount - promoDiscount;
      }
      await storage.updateOrder(orderId, updateData);
      const fresh = await storage.getOrder(orderId);
      res.json(fresh);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  // ── Delete Order ──
  app.delete("/api/orders/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const orderId = Number(req.params.id);
      const order = await storage.getOrder(orderId);
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

      if (order.promoCode) {
        try {
          const promo = await storage.getPromoCodeByCode(order.promoCode);
          if (promo) {
            await storage.decrementPromoUsedCount(promo.id);
            await storage.deletePromoUsageByOrder(orderId);
          }
        } catch (_) {}
      }

      try {
        await rejectOrderInCampaigns(orderId);
      } catch (_) {}

      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await db.delete(orders).where(eq(orders.id, orderId));
      res.json({ message: "تم حذف الطلب" });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Withdrawals ──
  // ══════════════════════════════════════════════════════════════════
  app.get("/api/withdrawals/my", requireAuth, async (req: any, res) => {
    try {
      const withdrawals = await storage.getWithdrawals(req.user.id);
      res.json(withdrawals);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.get("/api/admin/withdrawals", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح - هذه البيانات للأدمن فقط" });
    try {
      const withdrawals = await storage.getWithdrawals();
      const withdrawalsWithStore = await Promise.all(withdrawals.map(async (w: any) => {
        const merchant = await storage.getUser(w.merchantId);
        return { ...w, storeName: merchant?.storeName || merchant?.phone || 'غير معروف' };
      }));
      res.json(withdrawalsWithStore);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.get("/api/withdrawals", requireAuth, async (req: any, res) => {
    try {
      if (req.user.role === "admin") return res.redirect("/api/admin/withdrawals");
      const withdrawals = await storage.getWithdrawals(req.user.id);
      res.json(withdrawals);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.post("/api/withdrawals", requireAuth, generalLimiter, async (req: any, res) => {
    try {
      const amt = Number(req.body.amount);
      if (!validateAmount(amt)) return res.status(400).json({ message: 'مبلغ غير صحيح' });
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
      try {
        const adminUsers = await db.execute(sql`SELECT id FROM users WHERE role = 'admin'`);
        const adminIds = (adminUsers.rows as any[]).map((u: any) => u.id);
        if (adminIds.length > 0) {
          const { sendPushNotification } = await import('./notifications');
          await sendPushNotification({
            userIds: adminIds,
            title: '💰 طلب سحب جديد',
            body: `طلب سحب بقيمة ${amt.toLocaleString()} د.ع من ${req.user.storeName || req.user.phone}`,
            data: { type: 'new_withdrawal', withdrawalId: w.id, amount: amt, merchantId: req.user.id },
          });
        }
      } catch (_) {}
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
      const oldStatus = w.status;
      const merchant = await storage.getUser(w.merchantId);
      if (!merchant) return res.status(404).json({ message: "التاجر غير موجود" });

      const isRejectedToOther = oldStatus === "rejected" && newStatus !== "rejected";
      const isAnyToRejected = newStatus === "rejected" && oldStatus !== "rejected";

      if (isAnyToRejected) {
        await storage.updateUser(w.merchantId, { balance: (merchant.balance || 0) + w.amount });
      } else if (isRejectedToOther) {
        if ((merchant.balance || 0) < w.amount) {
          return res.status(400).json({ message: "رصيد التاجر غير كافٍ لخصم المبلغ مرة ثانية" });
        }
        await storage.updateUser(w.merchantId, { balance: (merchant.balance || 0) - w.amount });
      }

      await storage.updateWithdrawal(wId, { status: newStatus });

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

  // ══════════════════════════════════════════════════════════════════
  // ── Profile ──
  // ══════════════════════════════════════════════════════════════════
  app.patch("/api/auth/profile", requireAuth, async (req: any, res) => {
    try {
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
        updateData.password = await bcrypt.hash(password, 10);
      }
      const updated = await storage.updateUser(req.user.id, updateData);
      res.json(sanitizeUser(updated));
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ' }); }
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

  // ══════════════════════════════════════════════════════════════════
  // ── Promo Codes Routes ──
  // ══════════════════════════════════════════════════════════════════

  app.get("/api/promo-codes", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const codes = await storage.getPromoCodes();
      const codesWithStats = await Promise.all(codes.map(async (c: any) => {
        try {
          const stats = await storage.getPromoStats(c.id);
          return { ...c, stats };
        } catch {
          return { ...c, stats: { usageCount: 0, totalDiscount: 0, uniqueUsers: 0 } };
        }
      }));
      res.json(codesWithStats);
    } catch (e: any) {
      console.error("Error getting promo codes:", e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.post("/api/promo-codes", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const {
        code, title, description, discountType, discountPercent, discountAmount,
        maxDiscount, appliesTo, targetType, targetUserIds, minCartAmount,
        startsAt, expiresAt, maxUses, maxUsesPerUser, isActive
      } = req.body;

      if (!code || !code.trim()) return res.status(400).json({ message: 'كود الخصم مطلوب' });
      if (!title || !title.trim()) return res.status(400).json({ message: 'عنوان الكود مطلوب' });

      const type = discountType === 'fixed' ? 'fixed' : 'percentage';
      if (type === 'percentage') {
        if (!discountPercent || Number(discountPercent) <= 0 || Number(discountPercent) > 100)
          return res.status(400).json({ message: 'نسبة الخصم يجب أن تكون بين 1 و 100' });
      } else {
        if (!discountAmount || Number(discountAmount) <= 0)
          return res.status(400).json({ message: 'مبلغ الخصم يجب أن يكون أكبر من صفر' });
      }

      const scope = appliesTo === 'shipping' ? 'shipping' : 'subtotal';

      const result = await storage.createPromoCode({
        code: code.trim().toUpperCase(),
        title: title.trim(),
        description: (description || '').trim(),
        discountType: type,
        discountPercent: type === 'percentage' ? Number(discountPercent) : 0,
        discountAmount: type === 'fixed' ? Number(discountAmount) : 0,
        maxDiscount: Number(maxDiscount) || 0,
        appliesTo: scope,
        targetType: targetType === 'specific' ? 'specific' : 'all',
        targetUserIds: (targetUserIds || '').toString().trim(),
        minCartAmount: Number(minCartAmount) || 0,
        startsAt: startsAt ? new Date(startsAt) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        maxUses: Number(maxUses) || 0,
        maxUsesPerUser: Number(maxUsesPerUser) || 1,
        isActive: isActive !== false,
      } as any);
      res.status(201).json(result);
    } catch (e: any) {
      if (e.message?.includes('unique') || e.message?.includes('duplicate')) {
        return res.status(400).json({ message: 'هذا الكود موجود مسبقاً' });
      }
      console.error("Error creating promo code:", e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.patch("/api/promo-codes/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const id = Number(req.params.id);
      const existing = await storage.getPromoCode(id);
      if (!existing) return res.status(404).json({ message: "الكود غير موجود" });

      const {
        code, title, description, discountType, discountPercent, discountAmount,
        maxDiscount, appliesTo, targetType, targetUserIds, minCartAmount,
        startsAt, expiresAt, maxUses, maxUsesPerUser, isActive
      } = req.body;

      const updateData: any = {};
      if (code !== undefined) updateData.code = code.trim().toUpperCase();
      if (title !== undefined) updateData.title = title.trim();
      if (description !== undefined) updateData.description = description.trim();
      if (discountType !== undefined) updateData.discountType = discountType === 'fixed' ? 'fixed' : 'percentage';
      if (discountPercent !== undefined) updateData.discountPercent = Number(discountPercent);
      if (discountAmount !== undefined) updateData.discountAmount = Number(discountAmount);
      if (maxDiscount !== undefined) updateData.maxDiscount = Number(maxDiscount);
      if (appliesTo !== undefined) updateData.appliesTo = appliesTo === 'shipping' ? 'shipping' : 'subtotal';
      if (targetType !== undefined) updateData.targetType = targetType === 'specific' ? 'specific' : 'all';
      if (targetUserIds !== undefined) updateData.targetUserIds = (targetUserIds || '').toString().trim();
      if (minCartAmount !== undefined) updateData.minCartAmount = Number(minCartAmount);
      if (startsAt !== undefined) updateData.startsAt = startsAt ? new Date(startsAt) : null;
      if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
      if (maxUses !== undefined) updateData.maxUses = Number(maxUses);
      if (maxUsesPerUser !== undefined) updateData.maxUsesPerUser = Number(maxUsesPerUser);
      if (isActive !== undefined) updateData.isActive = Boolean(isActive);

      const result = await storage.updatePromoCode(id, updateData);
      res.json(result);
    } catch (e: any) {
      if (e.message?.includes('unique') || e.message?.includes('duplicate')) {
        return res.status(400).json({ message: 'هذا الكود موجود مسبقاً' });
      }
      console.error("Error updating promo code:", e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.delete("/api/promo-codes/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      await storage.deletePromoCode(Number(req.params.id));
      res.json({ message: "تم الحذف" });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.post("/api/promo-codes/verify", requireAuth, generalLimiter, async (req: any, res) => {
    try {
      const { code, cartAmount, shippingCost } = req.body;
      if (!code || !code.trim()) {
        return res.status(400).json({ valid: false, message: 'أدخل كود الخصم' });
      }
      if (!cartAmount || Number(cartAmount) <= 0) {
        return res.status(400).json({ valid: false, message: 'قيمة السلة غير صحيحة' });
      }

      const result = await validatePromoCode(
        code.trim().toUpperCase(),
        req.user.id,
        {
          cartAmount: Number(cartAmount),
          shippingCost: Number(shippingCost) || 0,
        }
      );

      if (!result.valid) {
        return res.status(400).json({ valid: false, message: result.error });
      }

      res.json({
        valid: true,
        discount: result.discount,
        promo: {
          code: result.promo.code,
          title: result.promo.title,
          description: result.promo.description,
          discountType: result.promo.discountType,
          discountPercent: result.promo.discountPercent,
          discountAmount: result.promo.discountAmount,
          appliesTo: result.promo.appliesTo || 'subtotal',
        },
      });
    } catch (e: any) {
      console.error('Verify promo error:', e);
      res.status(500).json({ valid: false, message: 'حدث خطأ في الخادم' });
    }
  });

  app.get("/api/promo-codes/stats/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const id = Number(req.params.id);
      const stats = await storage.getPromoStats(id);
      const usages = await storage.getPromoUsages(id);
      const usagesWithNames = await Promise.all(usages.map(async (u: any) => {
        const user = await storage.getUser(u.userId);
        return { ...u, storeName: user?.storeName || `#${u.userId}` };
      }));
      res.json({ stats, usages: usagesWithNames });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Campaigns ──
  // ══════════════════════════════════════════════════════════════════

  app.get("/api/admin/campaigns", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const list = await storage.getCampaigns();
      res.json(list);
    } catch (e: any) {
      console.error('Error getting campaigns:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.get("/api/admin/campaigns/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const id = Number(req.params.id);
      const campaign = await storage.getCampaign(id);
      if (!campaign) return res.status(404).json({ message: 'الحملة غير موجودة' });

      const participants = await storage.getCampaignParticipants(id);
      const stats = await storage.getCampaignStats(id);

      res.json({ ...campaign, participants, stats });
    } catch (e: any) {
      console.error('Error getting campaign details:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.post("/api/admin/campaigns", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const {
        title, description, productId, targetCount,
        startsAt, endsAt, rewardType, rewardValue, rewardData,
      } = req.body;

      if (!validateString(title, 200))
        return res.status(400).json({ message: 'عنوان الحملة مطلوب' });
      if (!productId)
        return res.status(400).json({ message: 'المنتج مطلوب' });
      if (!targetCount || Number(targetCount) <= 0)
        return res.status(400).json({ message: 'الهدف يجب أن يكون أكبر من صفر' });
      if (!startsAt || !endsAt)
        return res.status(400).json({ message: 'تاريخ البداية والنهاية مطلوبان' });

      const startDate = new Date(startsAt);
      const endDate = new Date(endsAt);
      if (endDate <= startDate)
        return res.status(400).json({ message: 'تاريخ النهاية يجب أن يكون بعد البداية' });

      const VALID_REWARD_TYPES = ['cashback', 'shipping_code', 'product_code', 'free_shipping'];
      if (!VALID_REWARD_TYPES.includes(rewardType))
        return res.status(400).json({ message: 'نوع المكافأة غير صحيح' });

      const product = await storage.getProduct(Number(productId));
      if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });

      const result = await storage.createCampaign({
        title: title.trim(),
        description: (description || '').trim(),
        productId: Number(productId),
        targetCount: Number(targetCount),
        startsAt: startDate,
        endsAt: endDate,
        rewardType,
        rewardValue: Number(rewardValue) || 0,
        rewardData: typeof rewardData === 'string' ? rewardData : JSON.stringify(rewardData || {}),
        isActive: true,
      } as any);

      res.status(201).json(result);
    } catch (e: any) {
      console.error('Create campaign error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.patch("/api/admin/campaigns/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const id = Number(req.params.id);
      const campaign = await storage.getCampaign(id);
      if (!campaign) return res.status(404).json({ message: 'الحملة غير موجودة' });

      const {
        title, description, productId, targetCount,
        startsAt, endsAt, rewardType, rewardValue, rewardData, isActive,
      } = req.body;

      const updateData: any = {};
      if (title !== undefined) updateData.title = title.trim();
      if (description !== undefined) updateData.description = description.trim();
      if (productId !== undefined) updateData.productId = Number(productId);
      if (targetCount !== undefined) updateData.targetCount = Number(targetCount);
      if (startsAt !== undefined) updateData.startsAt = new Date(startsAt);
      if (endsAt !== undefined) updateData.endsAt = new Date(endsAt);
      if (rewardType !== undefined) updateData.rewardType = rewardType;
      if (rewardValue !== undefined) updateData.rewardValue = Number(rewardValue);
      if (rewardData !== undefined) {
        updateData.rewardData = typeof rewardData === 'string' ? rewardData : JSON.stringify(rewardData);
      }
      if (isActive !== undefined) updateData.isActive = Boolean(isActive);

      const result = await storage.updateCampaign(id, updateData);
      res.json(result);
    } catch (e: any) {
      console.error('Update campaign error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.delete("/api/admin/campaigns/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      await storage.deleteCampaign(Number(req.params.id));
      res.json({ success: true });
    } catch (e: any) {
      console.error('Delete campaign error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.get("/api/admin/campaigns/:id/stats", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const stats = await storage.getCampaignStats(Number(req.params.id));
      res.json(stats);
    } catch (e: any) {
      console.error('Campaign stats error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.get("/api/campaigns/my", requireAuth, async (req: any, res) => {
    try {
      const list = await storage.getUserCampaigns(req.user.id);
      res.json(list);
    } catch (e: any) {
      console.error('Error getting my campaigns:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.get("/api/campaigns/:id", requireAuth, async (req: any, res) => {
    try {
      const data = await storage.getCampaignWithProgress(
        Number(req.params.id),
        req.user.id
      );
      if (!data) return res.status(404).json({ message: 'الحملة غير موجودة' });
      res.json(data);
    } catch (e: any) {
      console.error('Error getting campaign:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.get("/api/campaigns/rewards/my", requireAuth, async (req: any, res) => {
    try {
      const rewards = await storage.getUserCampaignRewards(req.user.id);
      res.json(rewards);
    } catch (e: any) {
      console.error('Error getting my rewards:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Stores (المتاجر الإلكترونية) ──
  // ══════════════════════════════════════════════════════════════════

  // ─── جلب متجر التاجر الحالي ───
  app.get("/api/store/my", requireAuth, async (req: any, res) => {
    try {
      const store = await storage.getStoreByUserId(req.user.id);
      if (!store) return res.json({ store: null });

      const storeProds = await storage.getStoreProducts(store.id);

      res.json({
        store,
        products: storeProds,
      });
    } catch (e: any) {
      console.error('Error getting my store:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ─── إنشاء متجر جديد ───
  app.post("/api/store/create", requireAuth, generalLimiter, async (req: any, res) => {
    try {
      // تحقق: هل لديه متجر مسبقاً؟
      const existing = await storage.getStoreByUserId(req.user.id);
      if (existing) {
        return res.status(400).json({ message: 'لديك متجر بالفعل' });
      }

      const { name, description, phone, instagram, facebook, tiktok, color } = req.body;

      if (!validateString(name, 100))
        return res.status(400).json({ message: 'اسم المتجر مطلوب' });
      if (!phone || !STORE_PHONE_REGEX.test(phone.trim()))
        return res.status(400).json({ message: 'رقم التواصل غير صحيح' });
      if (color && !ALLOWED_STORE_COLORS.includes(color))
        return res.status(400).json({ message: 'اللون غير مدعوم' });

      // توليد كود فريد
      const code = await generateUniqueStoreCode();

      const store = await storage.createStore({
        userId: req.user.id,
        code,
        name: name.trim(),
        description: (description || '').trim(),
        phone: phone.trim(),
        instagram: (instagram || '').trim(),
        facebook: (facebook || '').trim(),
        tiktok: (tiktok || '').trim(),
        color: color || 'primary',
        isActive: true,
      } as any);

      res.status(201).json({ store });
    } catch (e: any) {
      console.error('Create store error:', e);
      res.status(500).json({ message: e.message || 'حدث خطأ في الخادم' });
    }
  });

  // ─── تعديل إعدادات المتجر ───
  app.patch("/api/store/settings", requireAuth, async (req: any, res) => {
    try {
      const store = await storage.getStoreByUserId(req.user.id);
      if (!store) return res.status(404).json({ message: 'ليس لديك متجر' });

      const { name, description, phone, instagram, facebook, tiktok, color, isActive } = req.body;

      const updateData: any = {};

      if (name !== undefined) {
        if (!validateString(name, 100))
          return res.status(400).json({ message: 'اسم المتجر غير صحيح' });
        updateData.name = name.trim();
      }
      if (phone !== undefined) {
        if (!STORE_PHONE_REGEX.test(phone.trim()))
          return res.status(400).json({ message: 'رقم التواصل غير صحيح' });
        updateData.phone = phone.trim();
      }
      if (description !== undefined) updateData.description = (description || '').trim();
      if (instagram !== undefined) updateData.instagram = (instagram || '').trim();
      if (facebook !== undefined) updateData.facebook = (facebook || '').trim();
      if (tiktok !== undefined) updateData.tiktok = (tiktok || '').trim();
      if (color !== undefined) {
        if (!ALLOWED_STORE_COLORS.includes(color))
          return res.status(400).json({ message: 'اللون غير مدعوم' });
        updateData.color = color;
      }
      if (isActive !== undefined) updateData.isActive = Boolean(isActive);

      const updated = await storage.updateStore(store.id, updateData);
      res.json({ store: updated });
    } catch (e: any) {
      console.error('Update store settings error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ─── إضافة منتج للمتجر ───
  app.post("/api/store/products", requireAuth, async (req: any, res) => {
    try {
      const store = await storage.getStoreByUserId(req.user.id);
      if (!store) return res.status(404).json({ message: 'ليس لديك متجر' });

      const { productId, price } = req.body;

      if (!productId)
        return res.status(400).json({ message: 'المنتج مطلوب' });
      if (!price || Number(price) <= 0)
        return res.status(400).json({ message: 'السعر يجب أن يكون أكبر من صفر' });

      const product = await storage.getProduct(Number(productId));
      if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
      if (product.isActive === false)
        return res.status(400).json({ message: 'المنتج غير متاح' });

      const finalPrice = Number(price);

      // ✅ تحقق: السعر لا يقل عن wholesalePrice
      if (finalPrice < product.wholesalePrice) {
        return res.status(400).json({
          message: `السعر يجب أن يكون ${product.wholesalePrice.toLocaleString()} د.ع أو أكثر`,
        });
      }

      const result = await storage.addProductToStore({
        storeId: store.id,
        productId: Number(productId),
        price: finalPrice,
      });

      res.status(201).json(result);
    } catch (e: any) {
      console.error('Add product to store error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ─── تعديل منتج في المتجر ───
  app.patch("/api/store/products/:id", requireAuth, async (req: any, res) => {
    try {
      const store = await storage.getStoreByUserId(req.user.id);
      if (!store) return res.status(404).json({ message: 'ليس لديك متجر' });

      const itemId = Number(req.params.id);
      const storeProds = await storage.getStoreProducts(store.id);
      const target = storeProds.find((sp: any) => sp.id === itemId);
      if (!target) return res.status(404).json({ message: 'المنتج غير موجود في متجرك' });

      const { price, isActive, sortOrder } = req.body;
      const updateData: any = {};

      if (price !== undefined) {
        if (Number(price) <= 0)
          return res.status(400).json({ message: 'السعر يجب أن يكون أكبر من صفر' });

        const product = await storage.getProduct(target.productId);
        if (product && Number(price) < product.wholesalePrice) {
          return res.status(400).json({
            message: `السعر يجب أن يكون ${product.wholesalePrice.toLocaleString()} د.ع أو أكثر`,
          });
        }
        updateData.price = Number(price);
      }

      if (isActive !== undefined) updateData.isActive = Boolean(isActive);
      if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder);

      const updated = await storage.updateStoreProduct(itemId, updateData);
      res.json(updated);
    } catch (e: any) {
      console.error('Update store product error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ─── حذف منتج من المتجر ───
  app.delete("/api/store/products/:productId", requireAuth, async (req: any, res) => {
    try {
      const store = await storage.getStoreByUserId(req.user.id);
      if (!store) return res.status(404).json({ message: 'ليس لديك متجر' });

      const productId = Number(req.params.productId);
      await storage.removeProductFromStore(store.id, productId);
      res.json({ success: true });
    } catch (e: any) {
      console.error('Remove product from store error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Store Public Endpoints (بدون auth) ──
  // ══════════════════════════════════════════════════════════════════

  // ─── بيانات متجر عام (بالكود) ───
  app.get("/api/store/public/:code", storePublicLimiter, async (req: any, res) => {
    try {
      const code = String(req.params.code).toUpperCase();
      const data = await storage.getStorePublic(code);
      if (!data) return res.status(404).json({ message: 'المتجر غير موجود' });
      res.json(data);
    } catch (e: any) {
      console.error('Get public store error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ─── منتج واحد من متجر عام ───
  app.get("/api/store/public/:code/product/:id", storePublicLimiter, async (req: any, res) => {
    try {
      const code = String(req.params.code).toUpperCase();
      const productId = Number(req.params.id);
      const data = await storage.getStoreProductPublic(code, productId);
      if (!data) return res.status(404).json({ message: 'المنتج غير موجود' });
      res.json(data);
    } catch (e: any) {
      console.error('Get public store product error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ─── إنشاء طلب من المتجر (بدون auth) ───
  app.post("/api/store/public/:code/order", storePublicLimiter, async (req: any, res) => {
    try {
      const code = String(req.params.code).toUpperCase();
      const store = await storage.getStoreByCode(code);
      if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });
      if (!store.isActive) return res.status(400).json({ message: 'المتجر معطّل' });

      const { items, customerName, customerPhone, backupPhone, province, address, notes } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: 'السلة فارغة' });
      if (items.length > 50)
        return res.status(400).json({ message: 'الحد الأقصى 50 منتج' });
      if (!validateString(customerName, 100))
        return res.status(400).json({ message: 'اسم الزبون مطلوب' });
      if (!validatePhone(customerPhone))
        return res.status(400).json({ message: 'رقم الهاتف غير صحيح' });
      if (!validateString(province, 50))
        return res.status(400).json({ message: 'المحافظة مطلوبة' });
      if (!validateString(address, 500))
        return res.status(400).json({ message: 'العنوان مطلوب' });

      // ✅ جلب منتجات المتجر النشطة
      const storeProds = await storage.getStoreProducts(store.id);
      const activeStoreProds = storeProds.filter((sp: any) => sp.isActive);

      let totalAmount = 0, totalCost = 0, totalCompanyCost = 0;
      const enrichedItems: any[] = [];

      for (const item of items) {
        const productId = Number(item.productId);
        const qty = Number(item.quantity);

        if (!productId || !qty || qty <= 0) {
          return res.status(400).json({ message: 'بيانات السلة غير صحيحة' });
        }

        const storeProduct = activeStoreProds.find((sp: any) => sp.productId === productId);
        if (!storeProduct) {
          return res.status(400).json({ message: `المنتج ${productId} غير متوفر في المتجر` });
        }

        const product = await storage.getProduct(productId);
        if (!product || product.isActive === false) {
          return res.status(400).json({ message: `المنتج "${storeProduct.product?.name || productId}" غير متاح` });
        }

        if (product.stock < qty) {
          return res.status(400).json({
            message: `"${product.name}" متوفر فقط ${product.stock} قطعة`,
          });
        }

        const price = storeProduct.price; // ✅ السعر من المتجر
        totalAmount += price * qty;
        totalCost += product.wholesalePrice * qty;
        totalCompanyCost += (product.companyWholesalePrice || 0) * qty;

        enrichedItems.push({
          productId,
          quantity: qty,
          price,
          cost: product.wholesalePrice,
        });
      }

      // ── التوصيل ──
      const isBasra = province.includes("البصرة");
      const shippingCost = isBasra ? 3000 : 5000;
      const finalAmount = totalAmount + shippingCost;

      // ── الحسابات ──
      const totalProfit = totalAmount - totalCost;
      const companyProfit = totalCost - totalCompanyCost;

      // ── إنشاء الطلب ──
      const order = await storage.createOrder({
        merchantId: store.userId,
        customerName, customerPhone, province, address,
        backupPhone: backupPhone || null,
        notes: notes || "",
        status: "processing",
        totalAmount: finalAmount,
        shippingCost,
        totalProfit,
        companyProfit,
        promoCode: "",
        promoDiscount: 0,
        source: 'store',
        storeId: store.id,
      }, enrichedItems);

      // ── تخفيض المخزون ──
      await Promise.all(enrichedItems.map(async (item: any) => {
        const product = await storage.getProduct(item.productId);
        if (product) {
          const newStock = Math.max(0, product.stock - item.quantity);
          await storage.updateProduct(item.productId, { stock: newStock });
          await db.insert(inventoryLog).values({
            productId: item.productId, adminId: null,
            change: -item.quantity, reason: 'order',
            note: `طلب متجر #${order?.id}`, stockAfter: newStock,
          }).catch(() => {});
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

      // ── تحديث رصيد التاجر ──
      const freshUser = await storage.getUser(store.userId);
      if (freshUser) {
        await storage.updateUser(store.userId, {
          pendingBalance: (freshUser.pendingBalance || 0) + totalProfit,
        });
      }

      // ── إشعار للتاجر (طلب جديد من متجره) ──
      try {
        const { sendPushNotification } = await import('./notifications');
        await sendPushNotification({
          userIds: [store.userId],
          title: '🛒 طلب من متجرك الإلكتروني',
          body: `طلب جديد #${order?.id} من ${customerName} — ${finalAmount.toLocaleString()} د.ع`,
          data: { type: 'store_order', orderId: String(order?.id ?? '') },
        });
      } catch (_) {}

      // ── إشعار للأدمن ──
      try {
        const adminUsers = await db.execute(sql`SELECT id FROM users WHERE role = 'admin'`);
        const adminIds = (adminUsers.rows as any[]).map((u: any) => u.id);
        if (adminIds.length > 0) {
          const { sendPushNotification } = await import('./notifications');
          await sendPushNotification({
            userIds: adminIds,
            title: '🛍 طلب جديد (من متجر)',
            body: `طلب من متجر "${store.name}" — ${finalAmount.toLocaleString()} د.ع`,
            data: { type: 'new_order', orderId: String(order?.id ?? '') },
          });
        }
      } catch (_) {}

      res.status(201).json({
        orderId: order?.id,
        totalAmount: finalAmount,
        storeName: store.name,
        storePhone: store.phone,
      });
    } catch (e: any) {
      console.error('Create store order error:', e);
      res.status(500).json({ message: e.message || 'حدث خطأ في الخادم' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Banners ──
  // ══════════════════════════════════════════════════════════════════
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

  // ══════════════════════════════════════════════════════════════════
  // ── Notifications ──
  // ══════════════════════════════════════════════════════════════════
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

  // ══════════════════════════════════════════════════════════════════
  // ── Admin Management ──
  // ══════════════════════════════════════════════════════════════════
  app.get('/api/admin/admins', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const result = await db.execute(sql`SELECT id, store_name, phone, merchant_id, is_super_admin, permissions, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC`);
      res.json(result.rows);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

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

  app.post('/api/admin/admins/:id/demote', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const adminId = Number(req.params.id);
      if (adminId === req.user.id) return res.status(400).json({ message: 'لا يمكنك تحويل حسابك' });
      await db.execute(sql`UPDATE users SET role = 'merchant', is_super_admin = FALSE, permissions = '[]' WHERE id = ${adminId} AND is_super_admin = FALSE`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

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

  app.delete('/api/admin/admins/:id', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const adminId = Number(req.params.id);
      if (adminId === req.user.id) return res.status(400).json({ message: 'لا يمكنك حذف حسابك' });
      await db.execute(sql`DELETE FROM users WHERE id = ${adminId} AND role = 'admin' AND is_super_admin = FALSE`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Favorites ──
  // ══════════════════════════════════════════════════════════════════
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

  // ══════════════════════════════════════════════════════════════════
  // ── Support Chat ──
  // ══════════════════════════════════════════════════════════════════
  app.get('/api/support/messages', requireAuth, async (req: any, res) => {
    try {
      const result = await db.execute(sql`SELECT * FROM support_messages WHERE user_id = ${req.user.id} ORDER BY created_at ASC`);
      await db.execute(sql`UPDATE support_messages SET is_read = TRUE WHERE user_id = ${req.user.id} AND from_admin = TRUE AND is_read = FALSE`);
      res.json(result.rows);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.post('/api/support/messages', requireAuth, async (req: any, res) => {
    try {
      const userResult = await db.execute(sql`SELECT support_blocked FROM users WHERE id = ${req.user.id}`);
      const isBlocked = (userResult.rows[0] as any)?.support_blocked;
      if (isBlocked) return res.status(403).json({ message: 'تم حظرك من إرسال الرسائل' });
      const { message, imageUrl } = req.body;
      if (!message?.trim() && !imageUrl) return res.status(400).json({ message: 'الرسالة فارغة' });
      const BAD_WORDS = ['كلب', 'حمار', 'غبي', 'احمق', 'خنزير', 'عاهرة', 'شرموطة', 'منيوك', 'ابن الكلب'];
      let filteredMsg = (message || '').trim();
      for (const word of BAD_WORDS) {
        filteredMsg = filteredMsg.replace(new RegExp(word, 'gi'), '***');
      }
      await db.execute(sql`INSERT INTO support_messages (user_id, from_admin, message, image_url) VALUES (${req.user.id}, FALSE, ${filteredMsg}, ${imageUrl || null})`);
      try {
        const adminUsers = await db.execute(sql`SELECT id FROM users WHERE role = 'admin'`);
        const adminIds = (adminUsers.rows as any[]).map((u: any) => u.id);
        if (adminIds.length > 0) {
          const { sendPushNotification } = await import('./notifications');
          await sendPushNotification({
            userIds: adminIds,
            title: '💬 رسالة دعم جديدة',
            body: `رسالة جديدة من ${req.user.storeName || req.user.phone}`,
            data: { type: 'support_message', userId: req.user.id },
          });
        }
      } catch (_) {}
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error in support messages:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  app.get('/api/admin/support', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const result = await db.execute(sql`SELECT sm.*, u.store_name, u.phone, u.support_blocked FROM support_messages sm JOIN users u ON u.id = sm.user_id ORDER BY sm.created_at ASC`);
      const map: Record<number, any> = {};
      for (const row of result.rows as any[]) {
        if (!map[row.user_id]) {
          map[row.user_id] = {
            userId: row.user_id, storeName: row.store_name, phone: row.phone,
            isBlocked: row.support_blocked, messages: [], unread: 0,
          };
        }
        map[row.user_id].messages.push(row);
        map[row.user_id].isBlocked = row.support_blocked;
        if (!row.from_admin && !row.is_read) map[row.user_id].unread++;
      }
      res.json(Object.values(map).sort((a: any, b: any) => {
        const aLast = a.messages[a.messages.length - 1]?.created_at || 0;
        const bLast = b.messages[b.messages.length - 1]?.created_at || 0;
        return new Date(bLast).getTime() - new Date(aLast).getTime();
      }));
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.post('/api/admin/support/:userId', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const userId = Number(req.params.userId);
      const { message, imageUrl } = req.body;
      if (!message?.trim() && !imageUrl) return res.status(400).json({ message: 'الرسالة فارغة' });
      const msgText = message?.trim() || '';
      await db.execute(sql`INSERT INTO support_messages (user_id, from_admin, message, image_url) VALUES (${userId}, TRUE, ${msgText}, ${imageUrl || null})`);
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

  app.get('/api/support/unread', requireAuth, async (req: any, res) => {
    try {
      const result = await db.execute(sql`SELECT COUNT(*) as count FROM support_messages WHERE user_id = ${req.user.id} AND from_admin = TRUE AND is_read = FALSE`);
      res.json({ count: Number((result.rows[0] as any)?.count || 0) });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.post('/api/admin/support/:userId/read', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const userId = Number(req.params.userId);
      await db.execute(sql`UPDATE support_messages SET is_read = TRUE WHERE user_id = ${userId} AND from_admin = FALSE AND is_read = FALSE`);
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

  app.post('/api/support/upload-image', requireAuth, async (req: any, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) return res.status(400).json({ message: 'لا توجد صورة' });
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

  // ══════════════════════════════════════════════════════════════════
  // ── Stats ──
  // ══════════════════════════════════════════════════════════════════
  app.get("/api/admin/stats-data", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const [ordersData, usersData, withdrawalsData, productsData] = await Promise.all([
        storage.getOrders(),
        storage.getAllUsers(),
        storage.getWithdrawals(),
        storage.getProducts(),
      ]);

      const ordersWithProfit = ordersData.map((order: any) => {
        if (order.totalProfit === undefined || order.totalProfit === null) {
          const itemsTotal = order.items?.reduce((sum: number, item: any) => sum + ((item.price || 0) * (item.quantity || 1)), 0) || 0;
          const promoDiscount = order.promoDiscount || 0;
          const totalCost = order.items?.reduce((sum: number, item: any) => sum + ((item.cost || 0) * (item.quantity || 1)), 0) || 0;
          const totalCompanyCost = order.items?.reduce((sum: number, item: any) => {
            const p = item.product || {};
            return sum + ((p.companyWholesalePrice || 0) * (item.quantity || 1));
          }, 0) || 0;

          order.totalProfit = itemsTotal - totalCost;
          order.companyProfit = (totalCost - totalCompanyCost) - promoDiscount;
        }
        return order;
      });

      const merchants = usersData.filter((u: any) => u.role !== 'admin');
      const merchantsWithStats = merchants.map((merchant: any) => {
        const merchantOrders = ordersData.filter((o: any) => o.merchantId === merchant.id);
        const delivered = merchantOrders.filter((o: any) => o.status === 'delivered');
        return {
          ...merchant,
          totalOrders: merchantOrders.length,
          deliveredOrders: delivered.length,
          totalRevenue: delivered.reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0),
          totalProfit: delivered.reduce((sum: number, o: any) => sum + (o.totalProfit || 0), 0),
        };
      });

      const productsWithStats = productsData.map((product: any) => {
        const productOrders = ordersData.filter((o: any) =>
          o.status === 'delivered' && o.items?.some((item: any) => item.productId === product.id)
        );
        const totalSold = productOrders.reduce((sum: number, o: any) => {
          const item = o.items?.find((i: any) => i.productId === product.id);
          return sum + (item?.quantity || 0);
        }, 0);
        return {
          ...product, totalSold,
          revenue: productOrders.reduce((sum: number, o: any) => {
            const item = o.items?.find((i: any) => i.productId === product.id);
            return sum + ((item?.price || 0) * (item?.quantity || 1));
          }, 0),
        };
      });

      const totalPromoDiscounts = ordersData.reduce(
        (sum: number, o: any) => sum + (o.promoDiscount || 0),
        0
      );

      res.json({
        orders: ordersWithProfit,
        users: usersData,
        withdrawals: withdrawalsData,
        products: productsWithStats,
        merchants: merchantsWithStats,
        stats: {
          totalOrders: ordersData.length,
          totalUsers: usersData.length,
          totalMerchants: merchants.length,
          totalProducts: productsData.length,
          totalWithdrawals: withdrawalsData.length,
          totalPromoDiscounts,
        },
      });
    } catch (error: any) {
      console.error('Error in /api/admin/stats-data:', error);
      res.status(500).json({ message: 'حدث خطأ أثناء جلب الإحصائيات', error: error.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Delete Account ──
  // ══════════════════════════════════════════════════════════════════
  app.delete("/api/auth/delete-account", requireAuth, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

      // حذف المتجر إن وجد
      const store = await storage.getStoreByUserId(userId);
      if (store) {
        await storage.deleteStore(store.id);
      }

      await db.delete(orders).where(eq(orders.merchantId, userId));
      await db.delete(withdrawals).where(eq(withdrawals.merchantId, userId));
      await db.delete(favorites).where(eq(favorites.userId, userId));
      await db.delete(notifications).where(eq(notifications.userId, userId));
      await db.delete(supportMessages).where(eq(supportMessages.userId, userId));
      await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
      await storage.deleteUser(userId);
      res.json({ message: "تم حذف الحساب بنجاح" });
    } catch (e: any) {
      console.error("Delete account error:", e);
      res.status(500).json({ message: "حدث خطأ في الخادم" });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Categories ──
  // ══════════════════════════════════════════════════════════════════
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT 'grid-outline', sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW()
    )`);
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

  app.get('/api/categories', async (_req, res) => {
    try {
      const result = await db.select().from(categories).orderBy(categories.sortOrder);
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.get('/api/categories/best-sellers', async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT p.id, p.name, p.category, SUM(oi.quantity) as total_sold
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ('delivered') AND p.is_active = TRUE AND p.stock > 0
        GROUP BY p.id, p.name, p.category
        ORDER BY total_sold DESC LIMIT 10
      `);
      res.json(result.rows);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

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

  app.patch('/api/categories/:id', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const { name, icon, sortOrder, isActive } = req.body;
      if (name !== undefined) {
        const oldCat = await db.select({ name: categories.name }).from(categories).where(eq(categories.id, Number(req.params.id))).limit(1);
        const oldName = oldCat[0]?.name;
        if (oldName && oldName !== name.trim()) {
          const prods = await db.select({ id: products.id, category: products.category })
            .from(products).where(sql`category LIKE ${'%' + oldName + '%'}`);
          for (const p of prods) {
            const updated = (p.category || '').split(',')
              .map((c: string) => c.trim() === oldName ? name.trim() : c.trim()).join(',');
            await db.update(products).set({ category: updated }).where(eq(products.id, p.id));
          }
        }
      }
      const update: any = {};
      if (name !== undefined) update.name = name.trim();
      if (icon !== undefined) update.icon = icon;
      if (sortOrder !== undefined) update.sortOrder = Number(sortOrder);
      if (isActive !== undefined) update.isActive = Boolean(isActive);
      const result = await db.update(categories).set(update).where(eq(categories.id, Number(req.params.id))).returning();
      res.json(result[0]);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  app.delete('/api/categories/:id', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const catResult = await db.select().from(categories).where(eq(categories.id, Number(req.params.id))).limit(1);
      const catName = catResult[0]?.name;
      if (catName) {
        const prods = await db.select({ id: products.id, category: products.category })
          .from(products).where(sql`category LIKE ${'%' + catName + '%'}`);
        for (const p of prods) {
          const updated = (p.category || '').split(',')
            .map((c: string) => c.trim()).filter((c: string) => c !== catName).join(',') || 'عام';
          await db.update(products).set({ category: updated }).where(eq(products.id, p.id));
        }
      }
      await db.delete(categories).where(eq(categories.id, Number(req.params.id)));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Inventory ──
  // ══════════════════════════════════════════════════════════════════
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS inventory_log (
      id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL, admin_id INTEGER,
      change INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT 'manual', note TEXT,
      stock_after INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW()
    )`);
  } catch (e) { console.log('inventory_log migration:', e); }

  app.get('/api/inventory', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const filter = req.query.filter as string;
      let prods = await storage.getProducts();
      if (filter === 'low') prods = prods.filter((p: any) => p.stock > 0 && p.stock <= 10);
      if (filter === 'out') prods = prods.filter((p: any) => p.stock === 0);
      if (filter === 'stale') {
        const staleResult = await db.execute(sql`SELECT DISTINCT product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at > NOW() - INTERVAL '30 days'`);
        const activeIds = new Set((staleResult.rows as any[]).map((r: any) => r.product_id));
        prods = prods.filter((p: any) => !activeIds.has(p.id) && p.stock > 0);
      }
      const enriched = await Promise.all(prods.map(async (p: any) => {
        const sales = await db.execute(sql`SELECT COALESCE(SUM(oi.quantity), 0) as total_sold FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = ${p.id} AND o.status = 'delivered'`);
        return { ...p, totalSold: Number((sales.rows[0] as any)?.total_sold || 0) };
      }));
      res.json(enriched);
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

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
      await db.insert(inventoryLog).values({
        productId, adminId: req.user.id, change: Number(change), reason,
        note: note || null, stockAfter: newStock,
      });
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

  app.get('/api/inventory/stats', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const prods = await storage.getProducts();
      const total = prods.length;
      const outOfStock = prods.filter((p: any) => p.stock === 0).length;
      const lowStock = prods.filter((p: any) => p.stock > 0 && p.stock <= 10).length;
      const totalValue = prods.reduce((s: number, p: any) => s + (p.wholesalePrice * p.stock), 0);
      const staleResult = await db.execute(sql`SELECT DISTINCT product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at > NOW() - INTERVAL '30 days'`);
      const activeIds = new Set((staleResult.rows as any[]).map((r: any) => r.product_id));
      const stale = prods.filter((p: any) => !activeIds.has(p.id) && p.stock > 0).length;
      res.json({ total, outOfStock, lowStock, stale, totalValue });
    } catch (e: any) { res.status(500).json({ message: 'حدث خطأ في الخادم' }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── Start Campaign Cron Jobs ──
  // ══════════════════════════════════════════════════════════════════
  try {
    startCampaignCron();
    console.log('✅ Campaign cron jobs started');
  } catch (e) {
    console.error('Failed to start campaign cron:', e);
  }

  return httpServer;
}
