import { db } from "./db";
import { products, orders, orderItems } from "@shared/schema";
import { eq, sql, and } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export const saqrAssistant = {
  analyzeProduct: async (identifier: string, merchantId: number) => {
    try {
      const productId = parseInt(identifier.replace(/[^0-9]/g, ""));
      if (isNaN(productId)) return "عيني، اكتبلي كود المنتج بشكل صحيح (مثلاً #123).";

      const product = await db.query.products.findFirst({ where: eq(products.id, productId) });
      if (!product) return "دورت بكل المخازن وما لكيت هذا المنتج. تأكد من الكود عيوني؟";

      const salesStats = await db.select({ totalSold: sql<number>\`count(\${orderItems.id})\` })
        .from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(eq(orderItems.productId, product.id), eq(orders.merchantId, merchantId)));

      const stats = salesStats[0] || { totalSold: 0 };

      const prompt = \`أنت "صقر"، مساعد منصة "تسليم" للدروب شوبينج في العراق. حلل هذا المنتج للتاجر بلهجة عراقية:
        الاسم: \${product.name}, الجملة: \${product.wholesalePrice}, المقترح: \${product.suggestedPrice}, المخزون: \${product.stock}, مبيعات التاجر: \${stats.totalSold}.
        المطلوب: تحليل الربح، تنبيه المخزون، كتابة بوست إعلاني جذاب، ونصيحة استهداف للمحافظات.\`;

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) { return "صار عندي خلل فني بسيط، حاول مرة ثانية عيوني."; }
  }
};
