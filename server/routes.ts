import { Express } from "express";
import { Server } from "http";
import { setupAuth, requireAuth } from "./auth";
import { storage } from "./storage";

export async function registerRoutes(httpServer: Server, app: Express) {
  setupAuth(app);

  // ── Products ──
  app.get("/api/products", async (req, res) => {
    try {
      res.json(await storage.getProducts());
    } catch (e: any) { res.status(500).json({ message: e.message }); }
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
    try {
      res.status(201).json(await storage.createProduct(req.body));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.put("/api/products/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      res.json(await storage.updateProduct(Number(req.params.id), req.body));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/products/:id", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      await storage.deleteProduct(Number(req.params.id));
      res.json({ message: "تم الحذف" });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
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
      if (req.user.role !== "admin" && order.merchantId !== req.user.id) {
        return res.status(403).json({ message: "غير مصرح" });
      }
      res.json(order);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/orders", requireAuth, async (req: any, res) => {
    try {
      const { items, customerName, customerPhone, province, address, notes } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "يجب إضافة منتج واحد على الأقل" });
      }
      let totalAmount = 0, totalCost = 0;
      const enrichedItems = await Promise.all(items.map(async (item: any) => {
        const product = await storage.getProduct(Number(item.productId));
        if (!product) throw new Error(`المنتج ${item.productId} غير موجود`);
        const qty = Number(item.quantity);
        const price = Number(item.sellingPrice);
        totalAmount += price * qty;
        totalCost += product.wholesalePrice * qty;
        return { productId: Number(item.productId), quantity: qty, price, cost: product.wholesalePrice };
      }));
      const isBasra = province.includes("البصرة");
      const shippingCost = isBasra ? 3000 : 5000;
      const totalProfit = totalAmount - totalCost;
      const order = await storage.createOrder({
        merchantId: req.user.id,
        customerName, customerPhone, province, address,
        notes: notes || "", status: "pending",
        totalAmount: totalAmount + shippingCost,
        shippingCost, totalProfit,
      }, enrichedItems);
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
      res.json(updated);
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
      res.json(await storage.updateWithdrawal(Number(req.params.id), { status: req.body.status }));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Profile ──
  app.patch("/api/auth/profile", requireAuth, async (req: any, res) => {
    try {
      const updated = await storage.updateUser(req.user.id, req.body);
      res.json(updated);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Admin Users ──
  app.get("/api/admin/users", requireAuth, async (req: any, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    try {
      res.json(await storage.getAllUsers());
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  return httpServer;
}
