import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import jwt from "jsonwebtoken";

const scryptAsync = promisify(scrypt);
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}
const JWT_SECRET = process.env.SESSION_SECRET;

// ── Rate Limiter عام (IP) ──
const authRateMap = new Map<string, { count: number; resetAt: number }>();
function authRateLimit(req: any, res: any, next: any) {
  const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const entry = authRateMap.get(key);
  if (!entry || now > entry.resetAt) {
    authRateMap.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > 10) {
    return res.status(429).json({ message: 'محاولات كثيرة، حاول بعد دقيقة' });
  }
  next();
}

// ── حظر بعد 5 محاولات فاشلة لنفس الرقم ──
const loginFailMap = new Map<string, { count: number; blockedUntil: number }>();
const BLOCK_DURATION = 15 * 60 * 1000; // 15 دقيقة
const MAX_ATTEMPTS = 5;

function checkLoginBlock(phone: string): { blocked: boolean; minutesLeft?: number } {
  const entry = loginFailMap.get(phone);
  if (!entry) return { blocked: false };
  const now = Date.now();
  if (entry.blockedUntil && now < entry.blockedUntil) {
    const minutesLeft = Math.ceil((entry.blockedUntil - now) / 60_000);
    return { blocked: true, minutesLeft };
  }
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    loginFailMap.delete(phone);
  }
  return { blocked: false };
}

function recordLoginFail(phone: string) {
  const now = Date.now();
  const entry = loginFailMap.get(phone) || { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_DURATION;
    entry.count = 0;
  }
  loginFailMap.set(phone, entry);
}

function clearLoginFail(phone: string) {
  loginFailMap.delete(phone);
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedPasswordBuf = Buffer.from(hashed, "hex");
  const suppliedPasswordBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedPasswordBuf, suppliedPasswordBuf);
}

// JWT Middleware — يجيب الـ user من الداتابيس دايماً لضمان أحدث بيانات
export function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    // نجيب الـ user من الداتابيس عشان نضمن is_super_admin و permissions محدثين
    storage.getUser(decoded.id).then(user => {
      if (!user) return res.status(401).json({ message: "Unauthorized" });
      const { password: _, ...u } = user;
      req.user = u;
      req.isAuthenticated = () => true;
      next();
    }).catch(() => res.status(401).json({ message: "Unauthorized" }));
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}

export function setupAuth(app: Express) {
  // Register
  app.post("/api/auth/register", authRateLimit, async (req, res) => {
    try {
      const { phone, password, storeName, address } = req.body;

      // ✅ Validation
      if (!phone || !/^07[0-9]{9}$/.test(phone.trim()))
        return res.status(400).json({ message: 'رقم الهاتف يجب أن يبدأ بـ 07 ويكون 11 رقم' });
      if (!password || password.trim().length < 6)
        return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      if (!storeName || storeName.trim().length < 2 || storeName.trim().length > 100)
        return res.status(400).json({ message: 'اسم المتجر يجب أن يكون بين 2 و 100 حرف' });

      const existing = await storage.getUserByPhone(phone.trim());
      if (existing) return res.status(400).json({ message: "رقم الهاتف مسجل مسبقاً" });
      const merchantId = `TSL-${Date.now().toString(36).toUpperCase()}`;
      const user = await storage.createUser({
        phone, storeName, address: address || "",
        password: await hashPassword(password),
        role: "merchant", merchantId, balance: 0, pendingBalance: 0,
      });
      const { password: _, ...u } = user;
      const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
      res.status(201).json({ ...u, token });
    } catch (err: any) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // Login
  app.post("/api/auth/login", authRateLimit, async (req, res) => {
    try {
      const { phone, password } = req.body;
      if (!phone) return res.status(400).json({ message: 'يرجى إدخال رقم الهاتف' });

      // تحقق من الحظر
      const blockStatus = checkLoginBlock(phone);
      if (blockStatus.blocked) {
        return res.status(429).json({
          message: `تم تعليق حسابك مؤقتاً بسبب محاولات متعددة. حاول بعد ${blockStatus.minutesLeft} دقيقة`
        });
      }

      const user = await storage.getUserByPhone(phone);
      if (!user || !(await comparePasswords(password, user.password))) {
        recordLoginFail(phone);
        const entry = loginFailMap.get(phone);
        const remaining = MAX_ATTEMPTS - (entry?.count || 0);
        const msg = remaining > 0
          ? `رقم الهاتف أو كلمة المرور غير صحيحة. تبقى ${remaining} محاولة`
          : 'رقم الهاتف أو كلمة المرور غير صحيحة';
        return res.status(401).json({ message: msg });
      }

      // نجح الدخول — امسح سجل الفشل
      clearLoginFail(phone);
      const { password: _, ...u } = user;
      const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
      res.json({ ...u, token });
    } catch (err: any) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // Logout
  app.post("/api/auth/logout", (req, res) => {
    res.json({ message: "تم تسجيل الخروج" });
  });

  // Me
  app.get("/api/auth/me", requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.user.id);
      if (!user) return res.status(401).json({ message: "Unauthorized" });
      const { password: _, ...u } = user;
      res.json(u);
    } catch (err: any) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // Refresh Token — يجدد التوكن قبل انتهاء صلاحيته
  app.post("/api/auth/refresh", requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.user.id);
      if (!user) return res.status(401).json({ message: "Unauthorized" });
      const { password: _, ...u } = user;
      const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
      res.json({ token });
    } catch (err: any) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // Update Profile
  app.patch("/api/auth/profile", requireAuth, async (req: any, res) => {
    try {
      const { storeName, phone, address, currentPassword, newPassword } = req.body;
      const user = await storage.getUser(req.user.id);
      if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

      if (newPassword) {
        if (!currentPassword) return res.status(400).json({ message: 'يرجى إدخال كلمة المرور الحالية' });
        const valid = await comparePasswords(currentPassword, user.password);
        if (!valid) return res.status(400).json({ message: 'كلمة المرور الحالية غير صحيحة' });
        const hashed = await hashPassword(newPassword);
        await storage.updateUser(req.user.id, { password: hashed });
        return res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
      }

      const updates: any = {};
      if (storeName) updates.storeName = storeName;
      if (phone) updates.phone = phone;
      if (address !== undefined) updates.address = address;
      await storage.updateUser(req.user.id, updates);
      const updated = await storage.getUser(req.user.id);
      const { password: _, ...u } = updated!;
      res.json(u);
    } catch (err: any) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });
}
