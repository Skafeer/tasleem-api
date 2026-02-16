import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import jwt from "jsonwebtoken";

const scryptAsync = promisify(scrypt);
const JWT_SECRET = process.env.SESSION_SECRET || "tasleem_secret_2026";

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

// JWT Middleware
export function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    req.isAuthenticated = () => true;
    next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}

export function setupAuth(app: Express) {
  // Register
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { phone, password, storeName, address } = req.body;
      const existing = await storage.getUserByPhone(phone);
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
      res.status(500).json({ message: err.message });
    }
  });

  // Login
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { phone, password } = req.body;
      const user = await storage.getUserByPhone(phone);
      if (!user || !(await comparePasswords(password, user.password))) {
        return res.status(401).json({ message: "رقم الهاتف أو كلمة المرور غير صحيحة" });
      }
      const { password: _, ...u } = user;
      const token = jwt.sign(u, JWT_SECRET, { expiresIn: '30d' });
      res.json({ ...u, token });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
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
      res.status(500).json({ message: err.message });
    }
  });
}
