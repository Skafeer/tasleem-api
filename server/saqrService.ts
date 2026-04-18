import { db } from "./db";
import { products, orders, orderItems } from "@shared/schema";
import { eq, sql, and, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY is not set - Saqr AI will not work");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// ✅ FIX 1: اسم الموديل الصحيح — gemini-2.0-flash-lite أسرع وأرخص للتحليلات
// بدائل مرتبة حسب الأفضلية:
// "gemini-2.0-flash-lite"   → الأسرع والأرخص
// "gemini-2.0-flash-001"    → مستقر ومضمون
// "gemini-2.0-flash"        → fallback قديم وموثوق
const GEMINI_MODEL = "gemini-2.0-flash-lite";

export const saqrAssistant = {
  analyzeProduct: async (identifier: string, merchantId: number) => {
    if (!process.env.GEMINI_API_KEY) {
      return "صقر غير متاح حالياً، تواصل مع الدعم.";
    }

    // ✅ FIX 2: حد طول الـ identifier لمنع abuse
    if (!identifier || identifier.trim().length === 0) {
      return "أرسل لي كود المنتج أو اسمه عيوني.";
    }
    const cleanIdentifier = identifier.trim().substring(0, 100);

    try {
      // ── بحث عن المنتج بالرقم أو الاسم ──
      let product: any;

      const productId = parseInt(cleanIdentifier.replace(/[^0-9]/g, ""));
      if (!isNaN(productId) && productId > 0) {
        const r = await db.select().from(products).where(eq(products.id, productId)).limit(1);
        product = r[0];
      }

      if (!product) {
        const r = await db.select().from(products).where(ilike(products.name, `%${cleanIdentifier}%`)).limit(1);
        product = r[0];
      }

      if (!product) {
        return "عذراً عيني، دورت بالرقم وبالاسم وما لكيت المنتج. تأكد من الكود أو الاسم؟";
      }

      // ── إحصائيات مبيعات التاجر لهذا المنتج ──
      const salesStats = await db
        .select({
          totalSold: sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
          totalOrders: sql<number>`count(distinct ${orders.id})`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(
          and(
            eq(orderItems.productId, product.id),
            eq(orders.merchantId, merchantId)
          )
        );

      const totalSold   = Number(salesStats[0]?.totalSold)  || 0;
      const totalOrders = Number(salesStats[0]?.totalOrders) || 0;

      // ── حساب هامش الربح ──
      const profit       = product.suggestedPrice - product.wholesalePrice;
      const profitMargin = product.wholesalePrice > 0
        ? ((profit / product.wholesalePrice) * 100).toFixed(1)
        : "0";

      // ── Prompt محسّن ──
      const prompt = `أنت "صقر" 🦅، مساعد منصة "تسليم" للدروب شوبينج في العراق.
جاوب بالعراقي الصريح، منظم، وعملي. استخدم إيموجيات خفيفة.

📦 بيانات المنتج:
- الاسم: ${product.name}
- سعر الجملة (يدفعه التاجر): ${product.wholesalePrice.toLocaleString()} د.ع
- السعر المقترح للبيع: ${product.suggestedPrice.toLocaleString()} د.ع
- أدنى سعر بيع مسموح: ${product.sellingPriceMin.toLocaleString()} د.ع
- الربح المتوقع بالسعر المقترح: ${profit.toLocaleString()} د.ع (${profitMargin}%)
- المخزون المتوفر: ${product.stock} قطعة
- التصنيف: ${product.category || "عام"}
${product.discount > 0 ? `- خصم حالي على الجملة: ${product.discount}%` : ""}

📊 أداء التاجر مع هذا المنتج:
- عدد الطلبات: ${totalOrders} طلب
- إجمالي المبيع: ${totalSold} قطعة

المطلوب منك بالترتيب:
1. 💰 تحليل الربح: هل يستاهل؟ وكم الربح الفعلي بأسعار مختلفة؟
2. 📦 حالة المخزون: تنبيه إذا المخزون قليل أو كافي
3. 📱 بوست إعلاني جاهز للنسخ على السوشيال ميديا (مناسب للعراق)
4. 🗺️ نصيحة: أي محافظات عراقية تستهدف وليش؟`;

      // ✅ FIX 3: استخدام الاسم الصحيح للموديل
      const model  = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent(prompt);
      const text   = result.response.text();

      if (!text || text.trim().length === 0) {
        return "صقر جاوب بشي فاضي، حاول مرة ثانية عيوني.";
      }

      return text;

    } catch (error: any) {
      // ✅ FIX 4: تشخيص دقيق للخطأ
      const msg = error?.message || String(error);
      console.error("Saqr error:", msg);

      if (msg.includes("404") || msg.includes("not found") || msg.includes("model")) {
        console.error("❌ Gemini model name is wrong or deprecated:", GEMINI_MODEL);
        return "خلل في موديل الذكاء الاصطناعي، تواصل مع المطور.";
      }

      if (msg.includes("API_KEY") || msg.includes("401") || msg.includes("403")) {
        return "مفتاح Gemini منتهي أو غلط، تواصل مع المطور.";
      }

      if (msg.includes("quota") || msg.includes("429") || msg.includes("rate")) {
        return "صقر مشغول هسه، انتظر دقيقة وحاول مرة ثانية.";
      }

      return "صار عندي خلل فني بسيط، حاول مرة ثانية عيوني.";
    }
  },
};