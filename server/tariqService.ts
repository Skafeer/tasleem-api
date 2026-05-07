import { db } from "./db";
import { products, orders, orderItems, withdrawals, users } from "@shared/schema";
import { eq, sql, and, desc, gte, lt } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY is not set - Tariq AI will not work");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const GEMINI_MODEL = "models/gemini-2.5-flash-lite";

// ── أنواع المحادثة ──
export type ChatMessage = {
  role: "user" | "model";
  parts: [{ text: string }];
};

// ── جمع بيانات التاجر الكاملة من DB ──
async function getMerchantContext(merchantId: number): Promise<string> {
  try {
    // ── بيانات التاجر الأساسية ──
    const merchantData = await db
      .select({
        storeName: users.storeName,
        balance: users.balance,
        pendingBalance: users.pendingBalance,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, merchantId))
      .limit(1);

    const merchant = merchantData[0];
    if (!merchant) return "لا توجد بيانات للتاجر.";

    // ── إحصائيات الطلبات ──
    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - now.getDay());
    startOfThisWeek.setHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0);

    // كل الطلبات
    const allOrders = await db
      .select({
        id:          orders.id,
        status:      orders.status,
        totalProfit: orders.totalProfit,
        totalAmount: orders.totalAmount,
        createdAt:   orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.merchantId, merchantId))
      .orderBy(desc(orders.createdAt));

    const totalOrders     = allOrders.length;
    const pendingOrders   = allOrders.filter(o => o.status === "pending").length;
    const deliveredOrders = allOrders.filter(o => o.status === "delivered").length;
    const cancelledOrders = allOrders.filter(o => o.status === "cancelled").length;

    // أرباح هذا الشهر
    const thisMonthOrders = allOrders.filter(o =>
      o.createdAt && new Date(o.createdAt) >= startOfThisMonth && o.status === "delivered"
    );
    const thisMonthProfit = thisMonthOrders.reduce((s, o) => s + (o.totalProfit || 0), 0);

    // أرباح الشهر الماضي
    const lastMonthOrders = allOrders.filter(o =>
      o.createdAt &&
      new Date(o.createdAt) >= startOfLastMonth &&
      new Date(o.createdAt) <= endOfLastMonth &&
      o.status === "delivered"
    );
    const lastMonthProfit = lastMonthOrders.reduce((s, o) => s + (o.totalProfit || 0), 0);

    // مبيعات هذا الأسبوع vs الأسبوع الماضي
    const thisWeekOrders = allOrders.filter(o =>
      o.createdAt && new Date(o.createdAt) >= startOfThisWeek
    );
    const lastWeekOrders = allOrders.filter(o =>
      o.createdAt &&
      new Date(o.createdAt) >= startOfLastWeek &&
      new Date(o.createdAt) < startOfThisWeek
    );

    const thisWeekCount = thisWeekOrders.length;
    const lastWeekCount = lastWeekOrders.length;
    const weekChange    = lastWeekCount > 0
      ? (((thisWeekCount - lastWeekCount) / lastWeekCount) * 100).toFixed(0)
      : null;

    // إجمالي الأرباح الكلية
    const totalProfit = allOrders
      .filter(o => o.status === "delivered")
      .reduce((s, o) => s + (o.totalProfit || 0), 0);

    // ── أكثر المنتجات مبيعاً للتاجر ──
    const topProductsRaw = await db.execute(sql`
      SELECT p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount,
             COALESCE(SUM(oi.quantity), 0) as total_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.merchant_id = ${merchantId} AND o.status = 'delivered'
      GROUP BY p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount
      ORDER BY total_sold DESC
      LIMIT 5
    `);
    const topProducts = topProductsRaw.rows as any[];

    // ── المنتجات التي يبيعها التاجر (بناءً على طلباته) ──
    const merchantProductsRaw = await db.execute(sql`
      SELECT DISTINCT p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount, p.is_active
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.merchant_id = ${merchantId}
      LIMIT 20
    `);
    const merchantProducts = merchantProductsRaw.rows as any[];

    // ── منتجات قريبة من النفاد (التاجر يبيعها) ──
    const lowStockProducts = merchantProducts.filter((p: any) => p.stock > 0 && p.stock <= 10);
    const outOfStockProducts = merchantProducts.filter((p: any) => p.stock === 0);

    // ── الطلبات المعلقة التفصيلية ──
    const pendingOrdersDetail = allOrders
      .filter(o => o.status === "pending")
      .slice(0, 5)
      .map(o => {
        const hoursAgo = o.createdAt
          ? Math.floor((now.getTime() - new Date(o.createdAt).getTime()) / 3600000)
          : 0;
        return `طلب #${o.id} (منذ ${hoursAgo} ساعة)`;
      });

    // ── آخر سحب ──
    const lastWithdrawal = await db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.merchantId, merchantId))
      .orderBy(desc(withdrawals.createdAt))
      .limit(1);

    // ── ترتيب التاجر مقارنة بالآخرين ──
    const rankingRaw = await db.execute(sql`
      SELECT merchant_id, SUM(total_profit) as total_profit
      FROM orders
      WHERE status = 'delivered'
        AND created_at >= ${startOfThisMonth.toISOString()}
      GROUP BY merchant_id
      ORDER BY total_profit DESC
    `);
    const ranking = rankingRaw.rows as any[];
    const merchantRank = ranking.findIndex((r: any) => r.merchant_id === merchantId) + 1;
    const totalMerchants = ranking.length;

    // ── منتجات مقترحة للتاجر (مو باعها من قبل، مخزون وفير) ──
    const suggestedProductsRaw = await db.execute(sql`
      SELECT p.id, p.name, p.stock, p.suggested_price, p.wholesale_price, p.discount, p.category
      FROM products p
      WHERE p.is_active = TRUE AND p.stock > 20
        AND p.id NOT IN (
          SELECT DISTINCT oi.product_id
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.merchant_id = ${merchantId}
        )
      ORDER BY p.stock DESC
      LIMIT 5
    `);
    const suggestedProducts = suggestedProductsRaw.rows as any[];

    // ── تجميع السياق ──
    const profitChangeText = lastMonthProfit > 0
      ? thisMonthProfit > lastMonthProfit
        ? `📈 أرباح هذا الشهر أعلى بـ ${((thisMonthProfit - lastMonthProfit) / lastMonthProfit * 100).toFixed(0)}% عن الشهر الماضي`
        : `📉 أرباح هذا الشهر أقل بـ ${((lastMonthProfit - thisMonthProfit) / lastMonthProfit * 100).toFixed(0)}% عن الشهر الماضي`
      : "أول شهر للتاجر";

    const weekChangeText = weekChange !== null
      ? Number(weekChange) >= 0
        ? `📈 طلبات هذا الأسبوع أعلى بـ ${weekChange}% عن الأسبوع الماضي`
        : `📉 طلبات هذا الأسبوع أقل بـ ${Math.abs(Number(weekChange))}% عن الأسبوع الماضي`
      : "أول أسبوع للتاجر";

    return `
━━━ بيانات التاجر (سرية - لا تشاركها) ━━━
الاسم: ${merchant.storeName}
الرصيد المتاح: ${(merchant.balance || 0).toLocaleString()} د.ع
الرصيد المعلق: ${(merchant.pendingBalance || 0).toLocaleString()} د.ع
${lastWithdrawal[0] ? `آخر سحب: ${lastWithdrawal[0].amount.toLocaleString()} د.ع (${lastWithdrawal[0].status === 'completed' ? 'مكتمل' : 'معلق'})` : 'لا يوجد سحب سابق'}

━━━ الأداء ━━━
إجمالي الطلبات: ${totalOrders} طلب
- مكتمل: ${deliveredOrders} | معلق: ${pendingOrders} | ملغي: ${cancelledOrders}
إجمالي الأرباح الكلية: ${totalProfit.toLocaleString()} د.ع
أرباح هذا الشهر: ${thisMonthProfit.toLocaleString()} د.ع
أرباح الشهر الماضي: ${lastMonthProfit.toLocaleString()} د.ع
${profitChangeText}
طلبات هذا الأسبوع: ${thisWeekCount} | الأسبوع الماضي: ${lastWeekCount}
${weekChangeText}
${merchantRank > 0 ? `ترتيبه بين التجار هذا الشهر: #${merchantRank} من ${totalMerchants} تاجر` : ''}

━━━ الطلبات المعلقة ━━━
${pendingOrders === 0 ? 'لا توجد طلبات معلقة ✅' : pendingOrdersDetail.join('\n')}

━━━ أكثر منتجاته مبيعاً ━━━
${topProducts.length === 0 ? 'لم يبع بعد' : topProducts.map((p: any, i: number) => {
  const disc = p.discount > 0 ? (1 - p.discount / 100) : 1;
  const ws   = (p.wholesale_price || 0) * disc;
  const profit = (p.suggested_price || 0) - ws;
  return `${i + 1}. ${p.name} — ${p.total_sold} قطعة مباعة — ربح/قطعة: ${profit.toLocaleString()} د.ع — مخزون: ${p.stock}`;
}).join('\n')}

━━━ تحذيرات المخزون ━━━
${lowStockProducts.length === 0 && outOfStockProducts.length === 0
  ? 'المخزون بخير ✅'
  : [
      ...outOfStockProducts.map((p: any) => `❌ ${p.name} — نفد المخزون`),
      ...lowStockProducts.map((p: any) => `⚠️ ${p.name} — باقي ${p.stock} قطعة فقط`),
    ].join('\n')}

━━━ منتجات مقترحة لم يجربها بعد ━━━
${suggestedProducts.length === 0 ? 'جرب كل المنتجات!' : suggestedProducts.map((p: any) => {
  const disc = p.discount > 0 ? (1 - p.discount / 100) : 1;
  const ws   = (p.wholesale_price || 0) * disc;
  const profit = (p.suggested_price || 0) - ws;
  return `- ${p.name} (${p.category}) — ربح محتمل: ${profit.toLocaleString()} د.ع — مخزون: ${p.stock}`;
}).join('\n')}
`.trim();

  } catch (err) {
    console.error("getMerchantContext error:", err);
    return "تعذر جلب بيانات التاجر.";
  }
}

// ── System Prompt طارق ──
function buildSystemPrompt(merchantContext: string): string {
  return `أنت "طارق" 🤝، المساعد الشخصي الذكي للتجار في منصة "تسليم" للدروب شوبينج.

شخصيتك:
- أسلوبك شبابي ومرح، بلهجة بغدادية خفيفة وطبيعية
- مباشر وعملي — تعطي نصائح مبنية على أرقام حقيقية
- تستخدم إيموجي بس بدون مبالغة
- عندك خبرة المحاسب بالأرقام، وخبرة صاحب المحل بالنصيحة، وإبداع المسوق بالأفكار

قواعد صارمة:
- ممنوع النجمة (*) — استخدم الشرطة (-) للقوائم
- ممنوع مديح فارغ أو تطويل بلا فايدة
- لا تشارك سعر الجملة أو أرباح الشركة مع التاجر أبداً
- لا تذكر أنك تملك "بيانات سرية" — تصرف بشكل طبيعي كأنك تعرف التاجر
- إذا سألك عن شي خارج التجارة والبيع، ارفض بلطف ومرح وأرجعه للموضوع

نطاق عملك (فقط):
✅ تحليل المنتجات والتسعير
✅ استراتيجيات البيع والتسويق
✅ كتابة بوستات إعلانية
✅ تحليل أداء التاجر ونصائح التحسين
✅ اقتراح منتجات مناسبة
✅ أسئلة الدروب شوبينج العامة
✅ ردود قصيرة ودية (أهلاً، شكراً...)

خارج نطاقك:
❌ السياسة والأخبار والرياضة
❌ أي موضوع لا علاقة له بالتجارة
❌ طلبات شخصية لا تخص المنصة

━━━ بيانات التاجر الحالية ━━━
${merchantContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

استخدم هذه البيانات بذكاء في ردودك — لا تسردها كلها دفعة واحدة، بس استشهد بها عند الحاجة.`;
}

// ── الدالة الرئيسية: chat ──
export const tariqAssistant = {
  chat: async (
    messages: ChatMessage[],
    merchantId: number
  ): Promise<string> => {
    if (!process.env.GEMINI_API_KEY) {
      return "طارق غير متاح حالياً، تواصل مع الدعم.";
    }

    if (!messages || messages.length === 0) {
      return "أرسل لي رسالة عيوني 😄";
    }

    try {
      // جمع بيانات التاجر
      const merchantContext = await getMerchantContext(merchantId);
      const systemPrompt    = buildSystemPrompt(merchantContext);

      // إبقاء آخر 20 رسالة فقط لتجنب تجاوز الـ context
      const recentMessages = messages.slice(-20);

      const MAX_RETRIES = 3;
      let lastError: any;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            systemInstruction: systemPrompt,
          });

          // كل الرسائل ما عدا الأخيرة — مع ضمان أول رسالة دايماً user
          let history = recentMessages.slice(0, -1);
          while (history.length > 0 && history[0].role !== 'user') {
            history = history.slice(1);
          }

          const chat = model.startChat({ history });

          const lastMessage = recentMessages[recentMessages.length - 1];
          const result = await chat.sendMessage(lastMessage.parts[0].text);
          let text = result.response.text();

          // تنظيف النجوم
          text = text.replace(/\*/g, "");

          if (!text || text.trim().length === 0) {
            throw new Error("EMPTY_RESPONSE");
          }

          return text;

        } catch (error: any) {
          lastError = error;
          const msg = error?.message || String(error);

          if ((msg.includes("quota") || msg.includes("429") || msg.includes("rate")) && attempt < MAX_RETRIES) {
            console.log(`طارق مشغول.. محاولة ${attempt} من ${MAX_RETRIES}`);
            await sleep(2000);
            continue;
          }
          break;
        }
      }

      throw lastError;

    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error("Tariq error:", msg);

      if (msg.includes("404") || msg.includes("MODEL")) {
        return "خلل في موديل الذكاء الاصطناعي، تواصل مع المطور.";
      }
      if (msg.includes("API_KEY") || msg.includes("401") || msg.includes("403")) {
        return "مفتاح Gemini منتهي أو غلط، تواصل مع المطور.";
      }
      if (msg.includes("quota") || msg.includes("429") || msg.includes("rate")) {
        return "طارق مشغول هسه، انتظر دقيقة وحاول مرة ثانية 😄";
      }

      return "صار عندي خلل فني بسيط، حاول مرة ثانية عيوني.";
    }
  },

  // ── تحليل منتج محدد (نفس وظيفة صقر القديمة، محسّنة) ──
  analyzeProduct: async (identifier: string, merchantId: number): Promise<string> => {
    // نحوّل طلب تحليل المنتج لمحادثة عادية
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [{ text: `حلل لي هذا المنتج: ${identifier}` }],
      },
    ];
    return tariqAssistant.chat(messages, merchantId);
  },
};
