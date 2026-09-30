import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import { pool } from './db';
import cors from "cors";
import helmet from "helmet";

const app = express();

// ✅ Helmet — حماية HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // مطفي لأن API فقط
}));

// ══════════════════════════════════════════════════════════════════
// ── CORS — مطابقة تامة (Exact Match) — آمنة 100% ──
// ══════════════════════════════════════════════════════════════════

// ✅ دومينات الإنتاج الثابتة
const PROD_ORIGINS = [
  'https://matjari.vercel.app',
  'https://tasleem-dashboard.vercel.app',
];

// ✅ دومينات التطوير (فقط خارج production)
const DEV_ORIGINS =
  process.env.NODE_ENV === 'production'
    ? []
    : [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:8081',
        'http://localhost:19006',
      ];

// ✅ دومينات إضافية من env (مفصولة بفاصلة)
// على Railway: EXTRA_CORS_ORIGINS=https://xxx.app.github.dev,https://yyy.vercel.app
const EXTRA_ORIGINS = (process.env.EXTRA_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ✅ Set للمطابقة التامة O(1) — لا يمكن تجاوزها بـ suffix/prefix
const ALLOWED_ORIGINS = new Set<string>([
  ...PROD_ORIGINS,
  ...DEV_ORIGINS,
  ...EXTRA_ORIGINS,
]);

app.use(
  cors({
    origin: (origin, callback) => {
      // 1. بدون Origin header = طلب ليس من متصفح
      //    (mobile app / curl / Postman / server-side fetch)
      //    آمن لأن المتصفح لا يمكنه إخفاء الـ Origin
      if (!origin) return callback(null, true);

      // 2. مطابقة تامة — لا startsWith، لا regex
      if (ALLOWED_ORIGINS.has(origin)) {
        return callback(null, true);
      }

      // 3. رفض + تسجيل
      console.warn(`🚫 CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400, // 24 ساعة — يقلل طلبات preflight
  })
);

const httpServer = createServer(app);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      console.log(`${req.method} ${req.path} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });
  next();
});

app.get("/", (_req, res) => res.json({ status: "ok", app: "Tasleem API" }));

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Error:", err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  // إنشاء جدول البنرات إذا ما كان موجوداً
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_profit REAL NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL,
      link TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen({ port, host: "0.0.0.0" }, () => {
    console.log(`Tasleem API running on port ${port}`);
  });
})();