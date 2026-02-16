import { Express } from "express";
import { Server } from "http";
import { setupAuth } from "./auth";
import { storage } from "./storage";
import { z } from "zod";

export async function registerRoutes(httpServer: Server, app: Express) {
  setupAuth(app);

  // ── Products ──
  app.get("/api/products", async (req, res) => {
    try {
      const products = await storage.getProducts();
      res.json(products);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/products/:id", async (req, res) => {
    try {
      const product = await storage.getProduct(Number(req.params.id));
      if (!product) return res.status(404).json({ message: "المنتج غير موجود" });
      res.json(product);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/products", async (req, res) => {
    if (!req.isAuthenticated() || (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      const product = await storage.createProduct(req.body);
      res.status(201).json(product);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.put("/api/products/:id", async (req, res) => {
    if (!req.isAuthenticated() || (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      const product = await storage.updateProduct(Number(req.params.id), req.body);
      res.json(product);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/products/:id", async (req, res) => {
    if (!req.isAuthenticated() || (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      await storage.deleteProduct(Number(req.params.id));
      res.json({ message: "تم الحذف" });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Orders ──
  app.get("/api/orders", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
    try {
      const user = req.user as any;
      const merchantId = user.role === "admin" ? undefined : user.id;
      const orders = await storage.getOrders(merchantId);
      res.json(orders);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/orders/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
    try {
      const order = await storage.getOrder(Number(req.params.id));
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
      const user = req.user as any;
      if (user.role !== "admin" && order.merchantId !== user.id) {
        return res.status(403).json({ message: "غير مصرح" });
      }
      res.json(order);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/orders", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
    try {
      const user = req.user as any;
      const { items, customerName, customerPhone, province, address, notes } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "يجب إضافة منتج واحد على الأقل" });
      }

      let totalAmount = 0;
      let totalCost = 0;

      const enrichedItems = await Promise.all(items.map(async (item: any) => {
        const product = await storage.getProduct(Number(item.productId));
        if (!product) throw new Error(`المنتج ${item.productId} غير موجود`);
        const sellingPrice = Number(item.sellingPrice);
        const qty = Number(item.quantity);
        totalAmount += sellingPrice * qty;
        totalCost += product.wholesalePrice * qty;
        return {
          productId: Number(item.productId),
          quantity: qty,
          price: sellingPrice,
          cost: product.wholesalePrice,
        };
      }));

      const isBasra = province.includes("البصرة") || province.toLowerCase().includes("basra");
      const shippingCost = isBasra ? 3000 : 5000;
      const totalProfit = totalAmount - totalCost;
      const totalCustomerAmount = totalAmount + shippingCost;

      const order = await storage.createOrder({
        merchantId: user.id,
        customerName,
        customerPhone,
        province,
        address,
        notes: notes || "",
        status: "pending",
        totalAmount: totalCustomerAmount,
        shippingCost,
        totalProfit,
      }, enrichedItems);

      // Add to pending balance
      await storage.updateUser(user.id, {
        pendingBalance: (user.pendingBalance || 0) + totalProfit,
      });

      res.status(201).json(order);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/orders/:id/status", async (req, res) => {
    if (!req.isAuthenticated() || (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      const order = await storage.getOrder(Number(req.params.id));
      if (!order) return res.status(404).json({ message: "الطلب غير موجود" });

      const { status } = req.body;
      const updated = await storage.updateOrder(Number(req.params.id), { status });

      if (status === "delivered" && order.status !== "delivered") {
        const merchant = await storage.getUser(order.merchantId);
        if (merchant) {
          await storage.updateUser(merchant.id, {
            pendingBalance: Math.max(0, (merchant.pendingBalance || 0) - order.totalProfit),
            balance: (merchant.balance || 0) + order.totalProfit,
          });
        }
      }

      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Withdrawals ──
  app.get("/api/withdrawals", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
    try {
      const user = req.user as any;
      const merchantId = user.role === "admin" ? undefined : user.id;
      const list = await storage.getWithdrawals(merchantId);
      res.json(list);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/withdrawals", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
    try {
      const user = req.user as any;
      const { amount, method, accountDetails } = req.body;
      const amt = Number(amount);

      if (!amt || amt <= 0) return res.status(400).json({ message: "مبلغ غير صحيح" });
      if (amt > (user.balance || 0)) return res.status(400).json({ message: "رصيد غير كافٍ" });

      const w = await storage.createWithdrawal({
        merchantId: user.id,
        amount: amt,
        method: method || "manual",
        accountDetails: accountDetails || "",
        status: "pending",
      });

      await storage.updateUser(user.id, {
        balance: (user.balance || 0) - amt,
      });

      res.status(201).json(w);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/withdrawals/:id", async (req, res) => {
    if (!req.isAuthenticated() || (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      const w = await storage.updateWithdrawal(Number(req.params.id), { status: req.body.status });
      res.json(w);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Profile ──
  app.patch("/api/auth/profile", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
    try {
      const user = req.user as any;
      const { storeName, phone, address } = req.body;
      const updated = await storage.updateUser(user.id, { storeName, phone, address });
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Admin: All Users ──
  app.get("/api/admin/users", async (req, res) => {
    if (!req.isAuthenticated() || (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "غير مصرح" });
    }
    try {
      const allUsers = await storage.getAllUsers();
      res.json(allUsers);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  return httpServer;
}
