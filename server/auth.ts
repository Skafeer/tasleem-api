import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import jwt from "jsonwebtoken";
import { db } from "./db";
import { otpCodes } from "../shared/schema";
import { eq, and, gt } from "drizzle-orm";

const scryptAsync = promisify(scrypt);
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}
const JWT_SECRET = process.env.SESSION_SECRET;

// ── Otpiq OTP Sender ─────────────────────────────────────────────
const OTPIQ_KEY = process.env.OTPIQ_API_KEY || '';

async function sendOtpWhatsApp(phone: string, code: string): Promise<boolean> {
  try {
    // تحويل 07xxxxxxxx → +9647xxxxxxxx
    const intlPhone = phone.startsWith('0')
      ? '+964' + phone.slice(1)
      : phone.startsWith('964')
      ? '+' + phone
      : phone;

    const res = await fetch('https://api.otpiq.com/api/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OTPIQ_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        phoneNumber:      intlPhone,
        smsType:          'verification',
        provider:         'whatsapp-sms',   // واتساب أولاً، لو فشل SMS
        verificationCode: code,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Otpiq error:', data);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Otpiq OTP error:', e);
    return false;
  }
}

// ── OTP Helpers ──────────────────────────────────────────────────
async function hashOtp(code: string): Promise<string> {
  const salt = randomBytes(8).toString('hex');
  const buf  = (await scryptAsync(code, salt, 32)) as Buffer;
  return `${buf.toString('hex')}.${salt}`;
}

async function verifyOtp(code: string, hash: string): Promise<boolean> {
  const [hashed, salt] = hash.split('.');
  const buf = (await scryptAsync(code, salt, 32)) as Buffer;
  return timingSafeEqual(Buffer.from(hashed, 'hex'), buf);
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const otpRateMap = new Map<string, { count: number; resetAt: number }>();
function checkOtpRate(phone: string): boolean {
  const now   = Date.now();
  const entry = otpRateMap.get(phone);
  if (!entry || now > entry.resetAt) {
    otpRateMap.set(phone, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

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

// ── حظر بعد 5 محاولات فاشلة ──
const loginFailMap = new Map<string, { count: number; blockedUntil: number }>();
const BLOCK_DURATION = 15 * 60 * 1000;
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

export function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
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

  // ── 1. إرسال OTP ─────────────────────────────────────────────
  app.post("/api/auth/send-otp", authRateLimit, async (req, res) => {
    try {
      const { phone, type = 'register' } = req.body;
      if (!phone || !/^07[0-9]{9}$/.test(phone.trim()))
        return res.status(400).json({ message: 'رقم الهاتف يجب أن يبدأ بـ 07 ويكون 11 رقم' });
      if (!checkOtpRate(phone))
        return res.status(429).json({ message: 'تجاوزت الحد المسموح، حاول بعد ساعة' });
      if (type === 'register') {
        const existing = await storage.getUserByPhone(phone.trim());
        if (existing) return res.status(400).json({ message: 'رقم الهاتف مسجل مسبقاً' });
      }
      if (type === 'forgot_password') {
        const user = await storage.getUserByPhone(phone.trim());
        if (!user) return res.status(404).json({ message: 'هذا الرقم غير مسجل في تسليم' });
      }
      const code      = generateOtp();
      const codeHash  = await hashOtp(code);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await db.delete(otpCodes).where(and(eq(otpCodes.phone, phone), eq(otpCodes.type, type)));
      await db.insert(otpCodes).values({ phone, codeHash, type, expiresAt, attempts: 0, used: false });
      const sent = await sendOtpWhatsApp(phone, code);
      if (!sent) return res.status(500).json({ message: 'فشل إرسال رمز التحقق، حاول مرة أخرى' });
      res.json({ message: 'تم إرسال رمز التحقق' });
    } catch (e) {
      console.error('send-otp error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── 2. إعادة إرسال OTP ───────────────────────────────────────
  app.post("/api/auth/resend-otp", authRateLimit, async (req, res) => {
    try {
      const { phone, type = 'register' } = req.body;
      if (!phone || !/^07[0-9]{9}$/.test(phone.trim()))
        return res.status(400).json({ message: 'رقم هاتف غير صحيح' });
      if (!checkOtpRate(phone))
        return res.status(429).json({ message: 'تجاوزت الحد المسموح، حاول بعد ساعة' });
      const code      = generateOtp();
      const codeHash  = await hashOtp(code);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await db.delete(otpCodes).where(and(eq(otpCodes.phone, phone), eq(otpCodes.type, type)));
      await db.insert(otpCodes).values({ phone, codeHash, type, expiresAt, attempts: 0, used: false });
      const sent = await sendOtpWhatsApp(phone, code);
      if (!sent) return res.status(500).json({ message: 'فشل إرسال رمز التحقق' });
      res.json({ message: 'تم إعادة إرسال رمز التحقق' });
    } catch (e) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── 3. التسجيل مع OTP ────────────────────────────────────────
  app.post("/api/auth/register", authRateLimit, async (req, res) => {
    try {
      const { phone, password, storeName, address, otpCode } = req.body;
      if (!phone || !/^07[0-9]{9}$/.test(phone.trim()))
        return res.status(400).json({ message: 'رقم الهاتف يجب أن يبدأ بـ 07 ويكون 11 رقم' });
      if (!password || password.trim().length < 6)
        return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      if (!storeName || storeName.trim().length < 2)
        return res.status(400).json({ message: 'اسم المتجر مطلوب' });
      if (!otpCode)
        return res.status(400).json({ message: 'رمز التحقق مطلوب' });

      const now = new Date();
      const otpRows = await db.select().from(otpCodes)
        .where(and(eq(otpCodes.phone, phone), eq(otpCodes.type, 'register'), eq(otpCodes.used, false), gt(otpCodes.expiresAt, now)))
        .limit(1);
      if (!otpRows.length)
        return res.status(400).json({ message: 'رمز التحقق منتهي أو غير موجود، أعد الإرسال' });

      const otp = otpRows[0];
      if (otp.attempts >= 3) {
        await db.delete(otpCodes).where(eq(otpCodes.id, otp.id));
        return res.status(400).json({ message: 'تجاوزت عدد المحاولات، أعد إرسال الرمز' });
      }
      const valid = await verifyOtp(otpCode, otp.codeHash);
      if (!valid) {
        await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
        const remaining = 3 - (otp.attempts + 1);
        return res.status(400).json({
          message: remaining > 0 ? `رمز التحقق غير صحيح، تبقى ${remaining} محاولة` : 'رمز التحقق غير صحيح'
        });
      }
      const existing = await storage.getUserByPhone(phone.trim());
      if (existing) return res.status(400).json({ message: 'رقم الهاتف مسجل مسبقاً' });

      const merchantId = `TSL-${Date.now().toString(36).toUpperCase()}`;
      const user = await storage.createUser({
        phone, storeName, address: address || '',
        password: await hashPassword(password),
        role: 'merchant', merchantId, balance: 0, pendingBalance: 0,
      });
      await db.delete(otpCodes).where(eq(otpCodes.id, otp.id));
      const { password: _, ...u } = user;
      const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
      res.status(201).json({ ...u, token });
    } catch (e: any) {
      console.error('register error:', e);
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── 5. إعادة تعيين كلمة المرور ──────────────────────────────
  app.post("/api/auth/reset-password", authRateLimit, async (req, res) => {
    try {
      const { phone, otpCode, newPassword } = req.body;
      if (!phone || !otpCode || !newPassword)
        return res.status(400).json({ message: 'جميع الحقول مطلوبة' });
      if (newPassword.length < 6)
        return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });

      const now = new Date();
      const otpRows = await db.select().from(otpCodes)
        .where(and(eq(otpCodes.phone, phone), eq(otpCodes.type, 'forgot_password'), eq(otpCodes.used, false), gt(otpCodes.expiresAt, now)))
        .limit(1);
      if (!otpRows.length)
        return res.status(400).json({ message: 'رمز التحقق منتهي أو غير موجود' });

      const otp = otpRows[0];
      if (otp.attempts >= 3) {
        await db.delete(otpCodes).where(eq(otpCodes.id, otp.id));
        return res.status(400).json({ message: 'تجاوزت عدد المحاولات، أعد إرسال الرمز' });
      }
      const valid = await verifyOtp(otpCode, otp.codeHash);
      if (!valid) {
        await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
        const remaining = 3 - (otp.attempts + 1);
        return res.status(400).json({
          message: remaining > 0 ? `رمز التحقق غير صحيح، تبقى ${remaining} محاولة` : 'رمز التحقق غير صحيح'
        });
      }
      const user = await storage.getUserByPhone(phone);
      if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });
      await storage.updateUser(user.id, { password: await hashPassword(newPassword) });
      await db.delete(otpCodes).where(eq(otpCodes.id, otp.id));
      clearLoginFail(phone);
      res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (e) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── 6. تغيير كلمة المرور من الإعدادات ──────────────────────
  app.post("/api/auth/request-change-password", requireAuth, async (req: any, res) => {
    try {
      const phone = req.user.phone;
      if (!checkOtpRate(phone))
        return res.status(429).json({ message: 'تجاوزت الحد المسموح، حاول بعد ساعة' });
      const code      = generateOtp();
      const codeHash  = await hashOtp(code);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await db.delete(otpCodes).where(and(eq(otpCodes.phone, phone), eq(otpCodes.type, 'change_password')));
      await db.insert(otpCodes).values({ phone, codeHash, type: 'change_password', expiresAt, attempts: 0, used: false });
      const sent = await sendOtpWhatsApp(phone, code);
      if (!sent) return res.status(500).json({ message: 'فشل إرسال رمز التحقق' });
      res.json({ message: 'تم إرسال رمز التحقق' });
    } catch (e) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── Login ─────────────────────────────────────────────────────
  app.post("/api/auth/login", authRateLimit, async (req, res) => {
    try {
      const { phone, password } = req.body;
      if (!phone) return res.status(400).json({ message: 'يرجى إدخال رقم الهاتف' });
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
      clearLoginFail(phone);
      const { password: _, ...u } = user;
      const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
      res.json({ ...u, token });
    } catch (err: any) {
      res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
  });

  // ── Logout ────────────────────────────────────────────────────
  app.post("/api/auth/logout", (req, res) => {
    res.json({ message: "تم تسجيل الخروج" });
  });

  // ── Me ────────────────────────────────────────────────────────
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

  // ── Refresh Token ─────────────────────────────────────────────
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

  // ── Update Profile ────────────────────────────────────────────
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