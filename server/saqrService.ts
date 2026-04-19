import { db } from "./db";
import { products } from "@shared/schema";
import { eq, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const GEMINI_MODEL = "models/gemini-2.5-flash";

export const saqrAssistant = {
  analyzeProduct: async (identifier: string) => {
    try {
      let product: any;
      const cleanIdentifier = identifier.trim().substring(0, 100);
      const numericOnly = cleanIdentifier.replace(/[^0-9]/g, "");
      
      if (numericOnly === cleanIdentifier && numericOnly.length > 0) {
        const r = await db.select().from(products).where(eq(products.id, parseInt(numericOnly))).limit(1);
        product = r[0];
      }
      if (!product) {
        const r = await db.select().from(products).where(ilike(products.name, `%${cleanIdentifier}%`)).limit(1);
        product = r[0];
      }

      if (!product) return "عذراً عيني، ما لكيت المنتج. تأكد من الاسم أو الكود؟";

      const prompt = `أنت "صقر" 🦅، خبير مبيعات منصة "تسليم" في العراق.
حلل هذا المنتج بعمق بناءً على وصفه، واقترح أفضل سعر بيع يحقق أرباحاً وينافس بالسوق العراقي.
ممنوع استخدام النجوم (*). استخدم (-) للقوائم.

بيانات المنتج:
الاسم: ${product.name}
الوصف: ${product.description || "لا يوجد وصف مفصل"}
سعر الجملة: ${(product.wholesalePrice || 0).toLocaleString()} د.ع
السعر المقترح الحالي: ${(product.suggestedPrice || 0).toLocaleString()} د.ع
المخزون: ${product.stock} قطعة

المطلوب منك بالترتيب:
1. تحليل القيمة والسعر 💰: (ادرس الوصف جيداً، هل المنتج يستحق سعراً أعلى أم أقل؟ اقترح سعراً محدداً للبيع تراه الأنسب للتاجر).
2. حالة المخزون 📦: (سطر واحد عن التوفر).
3. نصيحة الاستهداف 🎯: (محافظات محددة وسبب اختيارها بناءً على نوع المنتج).
4. البوست الإعلاني 📱: (بوست احترافي باللهجة العراقية يركز على المميزات المذكورة بالوصف).

في نهاية الرد، أضف سطراً يبدأ بكلمة "اقتراحات:" متبوعاً بـ 3 أزرار مقترحة قصيرة جداً تناسب هذا المنتج حصراً، مفصولة بفاصلة.
مثال: اقتراحات: كيف أنافس بالسعر؟, بوست إعلاني قصير, مميزات المنتج`;

      const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent(prompt);
      return result.response.text().replace(/\*/g, '');
    } catch (error) { return "صار عندي خلل فني، حاول مرة ثانية عيوني."; }
  }
};
