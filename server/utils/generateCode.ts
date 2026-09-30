// server/utils/generateCode.ts
import { db } from "../db";
import { stores } from "@shared/schema";
import { eq } from "drizzle-orm";

// ── الأحرف المسموحة (بدون أحرف متشابهة) ──
// استثنينا: 0 O, 1 I L (لتفادي اللبس)
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

// ── توليد كود عشوائي (8 أحرف) ──
export function generateStoreCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const randomIndex = Math.floor(Math.random() * CHARS.length);
    code += CHARS[randomIndex];
  }
  return code;
}

// ── توليد كود فريد (يتأكد من عدم وجوده في قاعدة البيانات) ──
export async function generateUniqueStoreCode(maxAttempts = 10): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateStoreCode();

    // فحص هل الكود موجود؟
    const existing = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.code, code))
      .limit(1);

    if (existing.length === 0) {
      return code;
    }
  }

  // لو فشل بعد كل المحاولات (نادر جداً)
  throw new Error('فشل توليد كود فريد — حاول مرة أخرى');
}