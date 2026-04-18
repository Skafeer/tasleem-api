import { db } from "./db";
import { products, orders, orderItems } from "@shared/schema";
import { eq, sql, and, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY is not set - Saqr AI will not work");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export const saqrAssistant = {
  analyzeProduct: async (identifier: string, merchantId: number) => {
    if (!process.env.GEMINI_API_KEY) {
      return "صقر غير متاح حالياً، تواصل مع الدعم.";
    }
    try {
      let product;
      const productId = parseInt(identifier.replace(/[^0-9]/g, ""));

      if (!isNaN(productId) && productId > 0) {
        const r = await db.select().from(products).where(eq(products.id, productId)).limit(1);
        product = r[0];
      }

      if (!product) {
        const r = await db.select().from(products).where(ilike(products.name, `%${identifier}%`)).limit(1);
        product = r[0];
      }

      if (!product) return "عذراً عيني، دورت بالرقم وبالاسم وما لكيت المنتج. تأكد من الكود أو الاسم؟";

      const salesStats = await db
        .select({ totalSold: sql<number>`coalesce(sum(${orderItems.quantity}), 0)` })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(eq(orderItems.productId, product.id), eq(orders.merchantId, merchantId)));

      const totalSold = salesStats[0]?.totalSold || 0;

      const prompt = `أنت "صقر"، مساعد منصة "تسليم" للدروب شوبينج في العراق. حلل هذا المنتج للتاجر بلهجة عراقية:
        الاسم: ${product.name}, الجملة: ${product.wholesalePrice}, المقترح: ${product.suggestedPrice}, المخزون: ${product.stock}, مبيعات التاجر: ${totalSold}.
        المطلوب: تحليل الربح، تنبيه المخزون، كتابة بوست إعلاني جذاب، ونصيحة استهداف للمحافظات.`;

      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error("Saqr error:", error);
      return "صار عندي خلل فني بسيط، حاول مرة ثانية عيوني.";
    }
  }
};
