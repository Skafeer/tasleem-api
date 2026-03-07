import { Express } from "express";
import { Server } from "http";
import { setupAuth, requireAuth } from "./auth";
import { setupUpload } from "./upload";
import { storage } from "./storage";
import { db } from "./db";
import { promoCodes, products, orders, orderItems, banners } from "@shared/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

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

  // ── Migrations: إضافة أعمدة الصلاحيات ──
  try {
    await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT NOT NULL DEFAULT '[]'`);
    // أول أدمن موجود يصير super admin تلقائياً
    await db.execute(`UPDATE users SET is_super_admin = TRUE WHERE role = 'admin' AND (is_super_admin IS NULL OR is_super_admin = FALSE) AND id = (SELECT MIN(id) FROM users WHERE role = 'admin')`);
    console.log('✅ Admin permissions migration done');
  } catch (e) { console.log('Migration note:', e); }

  // ── Products ──
  app.get("/api/products", async (req: any, res) => {
    try {
      const all = await storage.getProducts();
      const activeOnly = req.query.activeOnly === 'true';
      res.json(activeOnly ? all.filter((p: any) => p.isActive !== false) : all);
    }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/products/:id", async (req, res) => {
    try {
      const p = await storage.getProduct(Number(req.params.id));
      if (!p) return res.status(404).json({ message: "المنتج غير موجود" });
      res.json(p);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/products", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try { res.status(201).json(await storage.createProduct(req.body)); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.put("/api/products/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try { res.json(await storage.updateProduct(Number(req.params.id), req.body)); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/products/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try { await storage.deleteProduct(Number(req.params.id)); res.json({ message: "تم الحذف" }); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Orders ──
  app.get("/api/orders", requireAuth, async (req: any, res) => {
    try {
      const merchantId = req.user.role === "admin" ? undefined : req.user.id;
      res.json(await storage.getOrders(merchantId));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/orders/:id", requireAuth, async (req: any, res) => {
    try {
      const order = await storage.getOrder(Number(req.params.id));
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
      if (req.user.role !== "admin" && order.merchantId !== req.user.id)
        return res.status(403).json({ message: "غير مصرح" });
      res.json(order);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/orders", requireAuth, async (req: any, res) => {
    try {
      const { items, customerName, customerPhone, province, address, notes, promoCode } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "يجب إضافة منتج واحد على الأقل" });

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
          await storage.updateProduct(item.productId, {
            stock: Math.max(0, product.stock - item.quantity),
          });
        }
      }));

      // تحديث رصيد التاجر
      const freshUser = await storage.getUser(req.user.id);
      if (freshUser) {
        await storage.updateUser(req.user.id, {
          pendingBalance: (freshUser.pendingBalance || 0) + totalProfit,
        });
      }

      res.status(201).json(order);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch("/api/orders/:id/status", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const order = await storage.getOrder(Number(req.params.id));
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
      const updated = await storage.updateOrder(Number(req.params.id), { status: req.body.status });
      if (req.body.status === "delivered" && order.status !== "delivered") {
        const merchant = await storage.getUser(order.merchantId);
        if (merchant) {
          await storage.updateUser(merchant.id, {
            pendingBalance: Math.max(0, (merchant.pendingBalance || 0) - order.totalProfit),
            balance: (merchant.balance || 0) + order.totalProfit,
          });
        }
      }
      // ✅ اذا مرتجع — رجع المخزون
      if (req.body.status === "returned" && order.status !== "returned") {
        const fullOrder = await storage.getOrder(order.id);
        if (fullOrder?.items) {
          await Promise.all(fullOrder.items.map(async (item: any) => {
            const product = await storage.getProduct(item.productId);
            if (product) {
              await storage.updateProduct(item.productId, {
                stock: product.stock + item.quantity,
              });
            }
          }));
        }
      }
      const STATUS_LABELS: Record<string, string> = {
        pending:    'قيد الانتظار ⏳',
        processing: 'قيد المعالجة 🔄',
        preparing:  'قيد التجهيز 📦',
        shipping:   'قيد التوصيل 🚴',
        delivered:  'تم التوصيل ✅',
        cancelled:  'ملغي ❌',
        returned:   'راجع 🔙',
        postponed:  'مؤجل ⏸',
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
    } catch (e: any) { res.status(500).json({ message: e.message }); }
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
    } catch (e: any) { res.status(500).json({ message: e.message }); }
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
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Withdrawals ──
  app.get("/api/withdrawals", requireAuth, async (req: any, res) => {
    try {
      const merchantId = req.user.role === "admin" ? undefined : req.user.id;
      res.json(await storage.getWithdrawals(merchantId));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/withdrawals", requireAuth, async (req: any, res) => {
    try {
      const amt = Number(req.body.amount);
      const freshUser = await storage.getUser(req.user.id);
      if (!amt || amt <= 0) return res.status(400).json({ message: "مبلغ غير صحيح" });
      if (amt > (freshUser?.balance || 0)) return res.status(400).json({ message: "رصيد غير كافٍ" });
      const w = await storage.createWithdrawal({
        merchantId: req.user.id, amount: amt,
        method: req.body.method || "manual",
        accountDetails: req.body.accountDetails || "",
        status: "pending",
      });
      await storage.updateUser(req.user.id, { balance: (freshUser?.balance || 0) - amt });
      res.status(201).json(w);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
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
        pending:  'قيد الانتظار ⏳',
        approved: 'تم القبول ✅',
        paid:     'تم الدفع 💰',
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
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Profile ──
  app.patch("/api/auth/profile", requireAuth, async (req: any, res) => {
    try { res.json(await storage.updateUser(req.user.id, req.body)); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Admin Users ──
  app.get("/api/admin/users", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try { res.json(await storage.getAllUsers()); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch("/api/admin/users/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const userId = Number(req.params.id);
      const { storeName, phone, address, password, balance } = req.body;
      const updateData: any = {};
      if (storeName  !== undefined) updateData.storeName = storeName;
      if (phone      !== undefined) updateData.phone = phone;
      if (address    !== undefined) updateData.address = address;
      if (balance    !== undefined) updateData.balance = Number(balance);
      if (password   !== undefined && password.trim() !== "") {
        const bcrypt = await import("bcrypt");
        updateData.password = await bcrypt.hash(password, 10);
      }
      const updated = await storage.updateUser(userId, updateData);
      res.json(updated);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/users/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      await storage.deleteUser(Number(req.params.id));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });


  // ── Promo Codes ──
  app.get("/api/promo-codes", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try { res.json(await db.select().from(promoCodes)); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/promo-codes", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      const result = await db.insert(promoCodes)
        .values({ code: req.body.code.toUpperCase(), discountPercent: Number(req.body.discountPercent), isActive: true })
        .returning();
      res.status(201).json(result[0]);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/promo-codes/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      await db.delete(promoCodes).where(eq(promoCodes.id, Number(req.params.id)));
      res.json({ message: "تم الحذف" });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
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
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/promo-codes/verify", async (req, res) => {
    try {
      const result = await db.select().from(promoCodes).where(eq(promoCodes.code, req.body.code.toUpperCase()));
      if (!result[0]?.isActive) return res.status(404).json({ message: "كود غير صحيح أو منتهي الصلاحية" });
      res.json({ discountPercent: result[0].discountPercent });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });


  // ── Banners ──
  app.get('/api/banners', async (req, res) => {
    try {
      const result = await db.select().from(banners).orderBy(banners.sortOrder);
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/banners', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const result = await db.insert(banners).values(req.body).returning();
      res.json(result[0]);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch('/api/banners/:id', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const { title, imageUrl, link, isActive, sortOrder } = req.body;
      const updateData: any = {};
      if (title      !== undefined) updateData.title      = title;
      if (imageUrl   !== undefined) updateData.imageUrl   = imageUrl;
      if (link       !== undefined) updateData.link       = link;
      if (isActive   !== undefined) updateData.isActive   = Boolean(isActive);
      if (sortOrder  !== undefined) updateData.sortOrder  = Number(sortOrder);
      const result = await db.update(banners).set(updateData).where(eq(banners.id, Number(req.params.id))).returning();
      res.json(result[0]);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete('/api/banners/:id', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      await db.delete(banners).where(eq(banners.id, Number(req.params.id)));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });


  // ── Debug: get all push tokens ──
  app.get('/api/push-tokens-debug', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const result = await db.execute(`SELECT * FROM push_tokens`);
      res.json(result.rows);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Notifications Routes ──

  app.post('/api/push-token', requireAuth, async (req: any, res) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ message: 'token مطلوب' });
      await db.execute(`INSERT INTO push_tokens (user_id, token) VALUES (${req.user.id}, '${token}') ON CONFLICT (token) DO UPDATE SET user_id = ${req.user.id}`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get('/api/notifications', requireAuth, async (req: any, res) => {
    try {
      const result = await db.execute(`SELECT * FROM notifications WHERE user_id = ${req.user.id} OR user_id IS NULL ORDER BY created_at DESC LIMIT 50`);
      res.json(result.rows);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch('/api/notifications/read-all', requireAuth, async (req: any, res) => {
    try {
      await db.execute(`UPDATE notifications SET is_read = TRUE WHERE user_id = ${req.user.id}`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/notifications/broadcast', requireAuth, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'غير مصرح' });
    try {
      const { title, body } = req.body;
      if (!title || !body) return res.status(400).json({ message: 'title و body مطلوبان' });
      const { sendBroadcastNotification } = await import('./notifications');
      await sendBroadcastNotification({ title, body });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ══════════════════════════════════════════
  // ── Admin Management Routes ──
  // ══════════════════════════════════════════

  // جلب كل الأدمنز (superAdmin فقط)
  app.get('/api/admin/admins', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const result = await db.execute(`SELECT id, store_name, phone, merchant_id, is_super_admin, permissions, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC`);
      res.json(result.rows);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // إضافة أدمن جديد (superAdmin فقط)
  app.post('/api/admin/admins', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const { storeName, phone, password, permissions } = req.body;
      if (!storeName || !phone || !password) return res.status(400).json({ message: 'جميع الحقول مطلوبة' });
      const existing = await db.execute(`SELECT id FROM users WHERE phone = '${phone}'`);
      if (existing.rows.length > 0) return res.status(400).json({ message: 'رقم الهاتف مستخدم مسبقاً' });
      const hashed = await bcrypt.hash(password, 10);
      const merchantId = 'ADMIN-' + Date.now().toString().slice(-6);
      const permsJson = JSON.stringify(permissions || []);
      await db.execute(`INSERT INTO users (phone, password, store_name, address, role, merchant_id, is_super_admin, permissions) VALUES ('${phone}', '${hashed}', '${storeName}', '', 'admin', '${merchantId}', FALSE, '${permsJson}')`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // تعديل صلاحيات أدمن (superAdmin فقط)
  app.patch('/api/admin/admins/:id', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const adminId = Number(req.params.id);
      const { permissions } = req.body;
      const permsJson = JSON.stringify(permissions || []);
      await db.execute(`UPDATE users SET permissions = '${permsJson}' WHERE id = ${adminId} AND role = 'admin' AND is_super_admin = FALSE`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // حذف أدمن (superAdmin فقط)
  app.delete('/api/admin/admins/:id', requireAuth, async (req: any, res) => {
    if (!req.user.is_super_admin && !req.user.isSuperAdmin) return res.status(403).json({ message: 'غير مصرح - سوبر أدمن فقط' });
    try {
      const adminId = Number(req.params.id);
      if (adminId === req.user.id) return res.status(400).json({ message: 'لا يمكنك حذف حسابك' });
      await db.execute(`DELETE FROM users WHERE id = ${adminId} AND role = 'admin' AND is_super_admin = FALSE`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  return httpServer;

}
