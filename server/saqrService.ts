import { db } from "./db";
import { products, orders, orderItems } from "@shared/schema";
import { eq, sql, and, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY is not set - Saqr AI will not work");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const GEMINI_MODEL = "models/gemini-2.5-flash";

export const saqrAssistant = {
  analyzeProduct: async (identifier: string, merchantId: number) => {
    if (!process.env.GEMINI_API_KEY) {
      return "صقر غير متاح حالياً، تواصل مع الدعم.";
    }

    if (!identifier || identifier.trim().length === 0) {
      return "أرسل لي كود المنتج أو اسمه عيوني.";
    }

    const cleanIdentifier = identifier.trim().substring(0, 100);

    try {
      let product: any;

      // البحث بالـ ID إذا كان المدخل أرقاماً فقط
      const numericOnly = cleanIdentifier.replace(/[^0-9]/g, "");
      if (numericOnly === cleanIdentifier && numericOnly.length > 0) {
        const productId = parseInt(numericOnly);
        if (!isNaN(productId) && productId > 0) {
          const r = await db.select().from(products).where(eq(products.id, productId)).limit(1);
          product = r[0];
        }
      }

      // البحث بالاسم إذا لم يتم العثور عليه بالـ ID
      if (!product) {
        const r = await db
          .select()
          .from(products)
          .where(ilike(products.name, `%${cleanIdentifier}%`))
          .limit(1);
        product = r[0];
      }

      if (!product) {
        return `ما لكيت منتج باسم أو كود "${cleanIdentifier}" 🔍\n\nتأكد من:\n- كتابة اسم المنتج بالعربي كما يظهر في التطبيق\n- أو رقم المنتج الرقمي فقط (مثل: 42)\n\nمثال: "سماعة أنكر" أو "15"`;
      }

      // إحصائيات مبيعات التاجر
      const salesStats = await db
        .select({
          totalSold:   sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
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

      const profit       = (product.suggestedPrice || 0) - (product.wholesalePrice || 0);
      const profitMargin = product.wholesalePrice > 0
        ? ((profit / product.wholesalePrice) * 100).toFixed(1)
        : "0";

      // البرومبت الجديد: مباشر، عملي، بدون نجوم، ومقسم بوضوح
      const prompt = `أنت "صقر" 🦅، مساعد منصة "تسليم" للدروب شوبينج في العراق.
مهمتك إعطاء التاجر "الزبدة" بلهجة عراقية عملية ومباشرة.
ممنوع منعاً باتاً استخدام علامة النجمة (*) في الرد. استخدم الشرطة (-) للقوائم.

بيانات المنتج:
الاسم: ${product.name}
سعر الجملة: ${(product.wholesalePrice || 0).toLocaleString()} د.ع
السعر المقترح: ${(product.suggestedPrice || 0).toLocaleString()} د.ع
الربح المتوقع: ${profit.toLocaleString()} د.ع (${profitMargin}%)
المخزون: ${product.stock} قطعة
مبيعات التاجر من هذا المنتج: ${totalSold} قطعة

اكتب الرد مقسماً إلى 4 أقسام واضحة ومفصولة بأسطر فارغة كالتالي:

الربح والمبيعات 💰
(اكتب سطرين مباشرين عن قيمة الربح وهل هو مجدي، مع ذكر مبيعات التاجر السابقة إذا وجدت)

حالة المخزون 📦
(سطر واحد يوضح هل المخزون كافي أم يحتاج استعجال بالبيع)

نصيحة الاستهداف 🎯
(سطرين عن أفضل المحافظات العراقية لاستهدافها لهذا المنتج ولماذا)

البوست الإعلاني 📱
(اكتب بوست جاهز للنسخ، جذاب، باللهجة العراقية، مع إيموجيات مناسبة، بدون ذكر سعر الجملة نهائياً، اذكر السعر المقترح فقط إذا لزم الأمر)`;

      const model  = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent(prompt);
      let text   = result.response.text();

      // تنظيف إضافي للتأكد من إزالة أي نجوم قد يولدها الموديل بالخطأ
      text = text.replace(/\*/g, '');

      if (!text || text.trim().length === 0) {
        return "صقر ما رد بشي، حاول مرة ثانية عيوني.";
      }

      return text;

    } catch (error: any) {
      console.error("Saqr error:", error?.message || String(error));
      return "صار عندي خلل فني بسيط، حاول مرة ثانية عيوني.";
    }
  },
};
