import { db } from "./db";
import { products } from "@shared/schema";
import { eq, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

// تأكد من طباعة تنبيه إذا كان المفتاح مفقوداً
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ ERROR: GEMINI_API_KEY is missing in environment variables!");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const GEMINI_MODEL = "models/gemini-2.5-flash";

export const saqrAssistant = {
  analyzeProduct: async (identifier: string) => {
    console.log(`🔍 Saqr is analyzing: "${identifier}"`);
    
    try {
      let product: any;
      const cleanIdentifier = identifier.trim();
      
      // 1. البحث عن المنتج
      const numericId = parseInt(cleanIdentifier.replace(/[^0-9]/g, ""));
      if (!isNaN(numericId)) {
        const r = await db.select().from(products).where(eq(products.id, numericId)).limit(1);
        product = r[0];
      }
      
      if (!product) {
        const r = await db.select().from(products).where(ilike(products.name, `%${cleanIdentifier}%`)).limit(1);
        product = r[0];
      }

      if (!product) {
        console.log("❌ Product not found in database");
        return "عذراً عيني، ما لكيت المنتج. تأكد من الاسم أو الكود؟";
      }

      console.log(`✅ Found product: ${product.name}`);

      // 2. استدعاء الذكاء الاصطناعي
      const prompt = `أنت "صقر" 🦅، خبير مبيعات منصة "تسليم" في العراق.
حلل هذا المنتج بعمق بناءً على وصفه، واقترح أفضل سعر بيع يحقق أرباحاً وينافس بالسوق العراقي.
ممنوع استخدام النجوم (*). استخدم (-) للقوائم.

بيانات المنتج:
الاسم: ${product.name}
الوصف: ${product.description || "لا يوجد وصف مفصل"}
سعر الجملة: ${product.wholesalePrice || 0}
السعر المقترح: ${product.suggestedPrice || 0}
المخزون: ${product.stock}

المطلوب:
1. تحليل القيمة والسعر 💰
2. حالة المخزون 📦
3. نصيحة الاستهداف 🎯
4. البوست الإعلاني 📱

اقتراحات: كيف أنافس بالسعر؟, بوست إعلاني قصير, مميزات المنتج`;

      const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      console.log("✅ Gemini responded successfully");
      return responseText.replace(/\*/g, '');

    } catch (error: any) {
      // طباعة الخطأ بالتفصيل في تيرمنال السيرفر
      console.error("❌ SAQR SERVICE ERROR:", error?.message || error);
      
      if (error?.message?.includes("API_KEY_INVALID")) {
        return "خطأ: مفتاح Gemini غير صحيح. تأكد من الإعدادات.";
      }
      if (error?.message?.includes("429")) {
        return "صقر عليه ضغط حالياً (Rate Limit)، انتظر دقيقة وحاول مرة ثانية.";
      }
      
      return "صار عندي خلل فني داخلي، حاول مرة ثانية عيوني.";
    }
  }
};
