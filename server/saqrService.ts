import { db } from "./db";
import { products, orders, orderItems } from "@shared/schema";
import { eq, sql, and, ilike } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

// وظيفة للانتظار قبل إعادة المحاولة
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY is not set - Saqr AI will not work");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
// تصحيح اسم النموذج إلى الإصدار المستقر 1.5
const GEMINI_MODEL = "models/gemini-1.5-flash";

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

      const numericOnly = cleanIdentifier.replace(/[^0-9]/g, "");
      if (numericOnly === cleanIdentifier && numericOnly.length > 0) {
        const productId = parseInt(numericOnly);
        if (!isNaN(productId) && productId > 0) {
          const r = await db.select().from(products).where(eq(products.id, productId)).limit(1);
          product = r[0];
        }
      }

      if (!product) {
        const r = await db.select().from(products)
          .where(ilike(products.name, `%${cleanIdentifier}%`))
          .limit(1);
        product = r[0];
      }

      if (!product) {
        return `ما لكيت منتج باسم أو كود "${cleanIdentifier}" 🔍\n\nتأكد من:\n- كتابة اسم المنتج بالعربي كما يظهر في التطبيق\n- أو رقم المنتج الرقمي فقط (مثل: 42)`;
      }

      // ── إحصائيات التاجر ──
      const salesStats = await db
        .select({
          totalSold:   sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
          totalOrders: sql<number>`count(distinct ${orders.id})`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(
          eq(orderItems.productId, product.id),
          eq(orders.merchantId, merchantId)
        ));

      const totalSold   = Number(salesStats[0]?.totalSold)  || 0;
      const totalOrders = Number(salesStats[0]?.totalOrders) || 0;

      const discount           = product.discount || 0;
      const effectiveWholesale = discount > 0
        ? (product.wholesalePrice || 0) * (1 - discount / 100)
        : (product.wholesalePrice || 0);
      const suggestedPrice  = product.suggestedPrice  || 0;
      const sellingPriceMin = product.sellingPriceMin || effectiveWholesale;
      const profit          = suggestedPrice - effectiveWholesale;
      const profitMargin    = effectiveWholesale > 0
        ? ((profit / effectiveWholesale) * 100).toFixed(0)
        : "0";
      const stockStatus = product.stock === 0 ? "نافذ ❌"
        : product.stock < 10 ? `شحيح ⚠️ (${product.stock} قطعة فقط)`
        : product.stock < 50 ? `معقول (${product.stock} قطعة)`
        : `وفير (${product.stock} قطعة)`;

      // ── وصف المنتج ──
      const descriptionSection = product.description && product.description.trim().length > 0
        ? `\nوصف المنتج الكامل:\n"${product.description.substring(0, 500)}"`
        : "\n(لا يوجد وصف للمنتج)";

      // ── السعر المناسب ──
      const priceRange = `أدنى سعر مسموح: ${sellingPriceMin.toLocaleString()} د.ع | السعر المقترح: ${suggestedPrice.toLocaleString()} د.ع`;

      const systemPrompt = `أنت "صقر" 🦅، خبير دروب شوبينج عراقي في منصة "تسليم".
شخصيتك: مباشر، عملي، بلهجة بغدادية خفيفة. تعطي نصائح مبنية على أرقام حقيقية.
ممنوع: علامة النجمة (*). استخدم الشرطة (-) للقوائم.
ممنوع: مديح فارغ أو تطويل بلا فايدة.`;

      const userPrompt = `حلل هذا المنتج للتاجر:

━━━ بيانات المنتج ━━━
الاسم: ${product.name}
التصنيف: ${product.category || "عام"}
سعر الجملة: ${effectiveWholesale.toLocaleString()} د.ع${discount > 0 ? ` (بعد خصم ${discount}%)` : ""}
${priceRange}
الربح بالسعر المقترح: ${profit.toLocaleString()} د.ع (${profitMargin}%)
المخزون: ${stockStatus}
${descriptionSection}

━━━ أداء التاجر ━━━
${totalOrders === 0
  ? "منتج جديد - ما بعت منه بعد"
  : `باع ${totalSold} قطعة بـ ${totalOrders} طلب`}

━━━ المطلوب ━━━

الربح والجدوى 💰
- هل يستاهل الوقت والجهد؟
- احسب الربح لو بعت 10 قطع وبعد 30 قطعة
- اقترح السعر الأمثل للبيع (بين ${sellingPriceMin.toLocaleString()} و${(suggestedPrice * 1.2).toLocaleString()} د.ع) وبررله ليش

المخزون والتوقيت 📦
- سطر وحده: هل يستعجل البيع أو الوضع مريح؟

تحليل المنتج 🔍
- بناءً على الوصف والمواصفات: شنو نقاط قوته الحقيقية؟
- شنو الفئة المستهدفة الأنسب له؟ (عمر، اهتمام، جنس)

نصيحة الاستهداف 🗺️
- 3 محافظات فقط مع سبب واحد لكل محافظة

البوست الإعلاني 📱
- جاهز للنسخ والنشر فوراً
- باللهجة العراقية الجذابة
- لا تذكر سعر الجملة نهائياً
- اذكر السعر المقترح بشكل جذاب
- أضف هاشتاقات عراقية مناسبة في النهاية`;

      // ── منطق إعادة المحاولة (Retry Logic) ──
      const MAX_RETRIES = 3;
      let lastError: any;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            systemInstruction: systemPrompt,
          });

          const result = await model.generateContent(userPrompt);
          let text = result.response.text();

          // تنظيف النجوم
          text = text.replace(/\*/g, "");

          if (!text || text.trim().length === 0) {
            throw new Error("EMPTY_RESPONSE");
          }

          return text; // نجح الطلب، نرجع النص فوراً

        } catch (error: any) {
          lastError = error;
          const msg = error?.message || String(error);
          
          // إذا كان الخطأ بسبب الضغط (Rate Limit) نحاول مرة ثانية
          if ((msg.includes("quota") || msg.includes("429") || msg.includes("rate")) && attempt < MAX_RETRIES) {
            console.log(`صقر مشغول.. محاولة رقم ${attempt} من ${MAX_RETRIES}. سأنتظر 2 ثانية...`);
            await sleep(2000); // انتظر ثانيتين قبل إعادة المحاولة
            continue;
          }
          break; // إذا كان خطأ آخر أو انتهت المحاولات نخرج من الحلقة
        }
      }

      // إذا وصلنا هنا يعني فشلت كل المحاولات، نرمي الخطأ ليعالجه الـ catch الخارجي
      throw lastError;

    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error("Saqr error:", msg);

      if (msg.includes("404") || msg.includes("not found") || msg.includes("MODEL")) {
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
