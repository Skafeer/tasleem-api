import { db } from "./db";
import { products, orders, orderItems } from "@shared/schema";
import { eq, sql, and, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export const saqrAssistant = {
  analyzeProduct: async (identifier: string, merchantId: number) => {
    try {
      let product;
      const productId = parseInt(identifier.replace(/[^0-9]/g, ""));
      if (!isNaN(productId)) {
        product = await db.query.products.findFirst({ where: eq(products.id, productId) });
      }
      if (!product) {
        product = await db.query.products.findFirst({ where: ilike(products.name, `%${identifier}%`) });
      }
      if (!product) return "عذراً عيني، دورت بالرقم وبالاسم وما لكيت المنتج. تأكد من الكود أو الاسم؟";

      const salesStats = await db.select({ totalSold: sql<number>\`sum(\${orderItems.quantity})\` })
        .from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(eq(orderItems.productId, product.id), eq(orders.merchantId, merchantId)));

      const stats = salesStats[0] || { totalSold: 0 };

      const prompt = \`أنت "صقر"، مساعد منصة "تسليم" للدروب شوبينج في العراق. حلل هذا المنتج للتاجر بلهجة عراقية:
        الاسم: \${product.name}, الجملة: \${product.wholesalePrice}, المقترح: \${product.suggestedPrice}, المخزون: \${product.stock}, مبيعات التاجر: \${stats.totalSold || 0}.
        المطلوب: تحليل الربح، تنبيه المخزون، كتابة بوست إعلاني جذاب، ونصيحة استهداف للمحافظات.\`;

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) { return "صار عندي خلل فني بسيط، حاول مرة ثانية عيوني."; }
  }
};
