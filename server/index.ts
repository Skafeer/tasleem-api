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

// ✅ CORS — مقيّد بالدومينات المعروفة
const ALLOWED_ORIGINS = [
  'http://localhost:8081',
  'http://localhost:19006',
  'exp://',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // بدون origin = mobile app أو Postman
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o as string))) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
}));

const httpServer = createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

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
