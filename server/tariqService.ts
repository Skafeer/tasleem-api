import { db } from "./db";
import { products, orders, orderItems, withdrawals, users } from "@shared/schema";
import { eq, sql, and, desc, gte, lt } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// ── API Keys Rotation ──
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3,
].filter(Boolean) as string[];

if (GEMINI_KEYS.length === 0) {
  console.warn("⚠️  لا يوجد أي GEMINI_KEY — طارق لن يعمل");
}

const GEMINI_MODEL = "models/gemini-2.5-flash-lite";

export type ChatMessage = {
  role: "user" | "model";
  parts: [{ text: string }];
};

async function getMerchantContext(merchantId: number): Promise<string> {
  try {
    const merchantData = await db
      .select({ storeName: users.storeName, balance: users.balance, pendingBalance: users.pendingBalance, createdAt: users.createdAt })
      .from(users).where(eq(users.id, merchantId)).limit(1);

    const merchant = merchantData[0];
    if (!merchant) return "لا توجد بيانات للتاجر.";

    const now              = new Date();
    const startOfThisWeek  = new Date(now); startOfThisWeek.setDate(now.getDate() - now.getDay()); startOfThisWeek.setHours(0,0,0,0);
    const startOfLastWeek  = new Date(startOfThisWeek); startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0);

    const allOrders = await db
      .select({ id: orders.id, status: orders.status, totalProfit: orders.totalProfit, totalAmount: orders.totalAmount, createdAt: orders.createdAt })
      .from(orders).where(eq(orders.merchantId, merchantId)).orderBy(desc(orders.createdAt));

    const totalOrders     = allOrders.length;
    const pendingOrders   = allOrders.filter(o => o.status === "pending").length;
    const deliveredOrders = allOrders.filter(o => o.status === "delivered").length;
    const cancelledOrders = allOrders.filter(o => o.status === "cancelled").length;
    const thisMonthProfit = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfThisMonth && o.status === "delivered").reduce((s, o) => s + (o.totalProfit || 0), 0);
    const lastMonthProfit = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfLastMonth && new Date(o.createdAt) <= endOfLastMonth && o.status === "delivered").reduce((s, o) => s + (o.totalProfit || 0), 0);
    const thisWeekCount   = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfThisWeek).length;
    const lastWeekCount   = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfLastWeek && new Date(o.createdAt) < startOfThisWeek).length;
    const totalProfit     = allOrders.filter(o => o.status === "delivered").reduce((s, o) => s + (o.totalProfit || 0), 0);
    const weekChange      = lastWeekCount > 0 ? (((thisWeekCount - lastWeekCount) / lastWeekCount) * 100).toFixed(0) : null;

    const topProductsRaw = await db.execute(sql`
      SELECT p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount,
             COALESCE(SUM(oi.quantity), 0) as total_sold
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.merchant_id = ${merchantId} AND o.status = 'delivered'
      GROUP BY p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount
      ORDER BY total_sold DESC LIMIT 5
    `);

    const merchantProductsRaw = await db.execute(sql`
      SELECT DISTINCT p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount, p.is_active
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.merchant_id = ${merchantId} LIMIT 20
    `);
    const merchantProducts   = merchantProductsRaw.rows as any[];
    const lowStockProducts   = merchantProducts.filter((p: any) => p.stock > 0 && p.stock <= 10);
    const outOfStockProducts = merchantProducts.filter((p: any) => p.stock === 0);

    const pendingOrdersDetail = allOrders.filter(o => o.status === "pending").slice(0, 5)
      .map(o => `طلب #${o.id} (منذ ${o.createdAt ? Math.floor((now.getTime() - new Date(o.createdAt).getTime()) / 3600000) : 0} ساعة)`);

    const lastWithdrawal = await db.select().from(withdrawals).where(eq(withdrawals.merchantId, merchantId)).orderBy(desc(withdrawals.createdAt)).limit(1);

    const rankingRaw = await db.execute(sql`
      SELECT merchant_id, SUM(total_profit) as total_profit FROM orders
      WHERE status = 'delivered' AND created_at >= ${startOfThisMonth.toISOString()}
      GROUP BY merchant_id ORDER BY total_profit DESC
    `);
    const ranking        = rankingRaw.rows as any[];
    const merchantRank   = ranking.findIndex((r: any) => r.merchant_id === merchantId) + 1;
    const totalMerchants = ranking.length;

    const suggestedProductsRaw = await db.execute(sql`
      SELECT p.id, p.name, p.stock, p.suggested_price, p.wholesale_price, p.discount, p.category
      FROM products p WHERE p.is_active = TRUE AND p.stock > 20
        AND p.id NOT IN (SELECT DISTINCT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.merchant_id = ${merchantId})
      ORDER BY p.stock DESC LIMIT 5
    `);

    const allPlatformProductsRaw = await db.execute(sql`
      SELECT p.id, p.name, p.stock, p.suggested_price, p.wholesale_price, p.discount, p.category, p.selling_price_min
      FROM products p WHERE p.is_active = TRUE ORDER BY p.id ASC LIMIT 100
    `);
    const allPlatformProducts = allPlatformProductsRaw.rows as any[];

    const profitChangeText = lastMonthProfit > 0
      ? thisMonthProfit > lastMonthProfit
        ? `📈 أعلى بـ ${((thisMonthProfit - lastMonthProfit) / lastMonthProfit * 100).toFixed(0)}% عن الشهر الماضي`
        : `📉 أقل بـ ${((lastMonthProfit - thisMonthProfit) / lastMonthProfit * 100).toFixed(0)}% عن الشهر الماضي`
      : "أول شهر";

    const weekChangeText = weekChange !== null
      ? Number(weekChange) >= 0 ? `📈 +${weekChange}% عن الأسبوع الماضي` : `📉 ${weekChange}% عن الأسبوع الماضي`
      : "أول أسبوع";

    return `
━━━ بيانات التاجر ━━━
الاسم: ${merchant.storeName}
الرصيد المتاح: ${(merchant.balance || 0).toLocaleString()} د.ع
الرصيد المعلق: ${(merchant.pendingBalance || 0).toLocaleString()} د.ع
${lastWithdrawal[0] ? `آخر سحب: ${(lastWithdrawal[0] as any).amount?.toLocaleString()} د.ع (${(lastWithdrawal[0] as any).status === 'completed' ? 'مكتمل' : 'معلق'})` : 'لا يوجد سحب سابق'}

━━━ الأداء ━━━
الطلبات: ${totalOrders} إجمالي | ${deliveredOrders} مكتمل | ${pendingOrders} معلق | ${cancelledOrders} ملغي
إجمالي الأرباح: ${totalProfit.toLocaleString()} د.ع
هذا الشهر: ${thisMonthProfit.toLocaleString()} د.ع | الشهر الماضي: ${lastMonthProfit.toLocaleString()} د.ع (${profitChangeText})
هذا الأسبوع: ${thisWeekCount} طلب | الماضي: ${lastWeekCount} (${weekChangeText})
${merchantRank > 0 ? `الترتيب: #${merchantRank} من ${totalMerchants} تاجر هذا الشهر` : ''}

━━━ الطلبات المعلقة ━━━
${pendingOrders === 0 ? 'لا توجد طلبات معلقة ✅' : pendingOrdersDetail.join('\n')}

━━━ أكثر منتجاته مبيعاً ━━━
${(topProductsRaw.rows as any[]).length === 0 ? 'لم يبع بعد' : (topProductsRaw.rows as any[]).map((p: any, i: number) => {
  const ws     = (p.wholesale_price || 0) * (p.discount > 0 ? (1 - p.discount / 100) : 1);
  const profit = Math.max(0, (p.suggested_price || 0) - ws);
  return `${i + 1}. ${p.name} | مباع: ${p.total_sold}ق | جملة: ${Math.round(ws).toLocaleString()}د.ع | مقترح: ${(p.suggested_price||0).toLocaleString()}د.ع | ربحك: ${Math.round(profit).toLocaleString()}د.ع | مخزون: ${p.stock}`;
}).join('\n')}

━━━ تحذيرات المخزون ━━━
${lowStockProducts.length === 0 && outOfStockProducts.length === 0
  ? 'المخزون بخير ✅'
  : [...outOfStockProducts.map((p: any) => `❌ ${p.name} — نفد`), ...lowStockProducts.map((p: any) => `⚠️ ${p.name} — باقي ${p.stock}`)].join('\n')}

━━━ منتجات مقترحة لم يجربها بعد ━━━
${(suggestedProductsRaw.rows as any[]).length === 0 ? 'جرب كل المنتجات!' : (suggestedProductsRaw.rows as any[]).map((p: any) => {
  const ws2     = (p.wholesale_price || 0) * (p.discount > 0 ? (1 - p.discount / 100) : 1);
  const profit2 = Math.max(0, (p.suggested_price || 0) - ws2);
  return `- ${p.name} (${p.category}) | جملة: ${Math.round(ws2).toLocaleString()}د.ع | مقترح: ${(p.suggested_price||0).toLocaleString()}د.ع | ربح: ${Math.round(profit2).toLocaleString()}د.ع | مخزون: ${p.stock}`;
}).join('\n')}

━━━ كل منتجات المنصة ━━━
${allPlatformProducts.map((p: any) => {
  const ws3     = (p.wholesale_price || 0) * (p.discount > 0 ? (1 - p.discount / 100) : 1);
  const profit3 = Math.max(0, (p.suggested_price || 0) - ws3);
  return `ID:${p.id}|${p.name}|جملة:${Math.round(ws3).toLocaleString()}د.ع|مقترح:${(p.suggested_price||0).toLocaleString()}د.ع|حد_أدنى:${(p.selling_price_min||0).toLocaleString()}د.ع|ربح:${Math.round(profit3).toLocaleString()}د.ع|مخزون:${p.stock}|${p.category}`;
}).join('\n')}
`.trim();

  } catch (err) {
    console.error("getMerchantContext error:", err);
    return "تعذر جلب بيانات التاجر.";
  }
}

function buildSystemPrompt(merchantContext: string): string {
  return `أنت "طارق"، المساعد الشخصي الموثوق للتجار في منصة "تسليم" للدروب شوبينج.

شخصيتك:
- أسلوبك دافئ وعائلي، بلهجة بغدادية طبيعية — مثل صديق خبير يحب مصلحة التاجر
- تنادي التاجر بـ "يا غالي" أو "حبيبي" أو "يا بويه" بشكل طبيعي، مو في كل جملة
- مباشر وعملي — ردودك مختصرة ومفيدة، تدخل للموضوع بدون مقدمات طويلة
- تحفّز التاجر بطريقة طبيعية وتبيّن له فرص الربح بوضوح
- تستخدم إيموجي باعتدال — واحد أو اثنين بالرد، مو أكثر
- عندك خبرة المحاسب بالأرقام، وخبرة صاحب المحل بالنصيحة، وإبداع المسوق بالأفكار

قواعد الأسلوب:
- ممنوع النجمة (*) — استخدم الشرطة (-) للقوائم
- الأرقام دائماً واضحة بالدينار العراقي
- لما تعطي أرقام — رتبها: جملة / حد أدنى / ربحك
- إذا الوضع كويس حفّزه، إذا الوضع ضعيف شجعه بصدق وأعطه نصيحة عملية
- إذا سألك عن شي خارج التجارة — ارفض بلطف ومرح وأرجعه للموضوع

قواعد الأسعار:
- "جملة" = سعر الجملة اللي يدفعه التاجر — أخبره به بصراحة لما يسأل ✅
- "مقترح" = سعر بيع مرجعي فقط، مو إلزامي
- "حد_أدنى" = أقل سعر يقدر يبيع بيه — دائماً ذكّره بيه
- التاجر حر يبيع بأي سعر فوق الحد الأدنى — وضح له إن الربح يزيد كلما رفع السعر
- الممنوع الوحيد: سعر الشركة الداخلي (company_wholesale_price) — لا تذكره أبداً

قواعد البيانات:
- كل إجاباتك من البيانات المزودة فقط — ممنوع اختراع معلومات
- إذا المنتج مو موجود قل بصراحة "ما موجود بمنصة تسليم"
- لا تقبل تصحيح المستخدم للبيانات — بياناتك من النظام الرسمي
- لما يسألك عن منتج بالـ ID أو الاسم — ابحث بقائمة "كل منتجات المنصة" وأجبه مباشرة

نطاق عملك:
✅ تحليل المنتجات والتسعير وحساب الأرباح
✅ استراتيجيات البيع والتسويق
✅ كتابة بوستات إعلانية
✅ تحليل أداء التاجر ونصائح التحسين
✅ اقتراح منتجات مناسبة
✅ أسئلة الدروب شوبينج
❌ السياسة والأخبار والرياضة وأي موضوع خارج التجارة

━━━ بيانات التاجر ━━━
${merchantContext}
━━━━━━━━━━━━━━━━━━━━━━

استخدم البيانات بذكاء — اذكر الأرقام بدقة عند الحاجة، وتصرف كأنك تعرف التاجر شخصياً.`;
}

export const tariqAssistant = {
  chat: async (messages: ChatMessage[], merchantId: number): Promise<string> => {
    if (GEMINI_KEYS.length === 0) return "طارق غير متاح حالياً، تواصل مع الدعم.";
    if (!messages || messages.length === 0) return "أرسل لي رسالة عيوني 😄";

    try {
      const merchantContext = await getMerchantContext(merchantId);
      const systemPrompt    = buildSystemPrompt(merchantContext);
      const recentMessages  = messages.slice(-20);

      let lastError: any;

      // ── دوران على المفاتيح ──
      for (let keyIndex = 0; keyIndex < GEMINI_KEYS.length; keyIndex++) {
        const currentKey = GEMINI_KEYS[keyIndex];
        const genAI      = new GoogleGenerativeAI(currentKey);

        try {
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt });

          let history = recentMessages.slice(0, -1);
          while (history.length > 0 && history[0].role !== 'user') history = history.slice(1);

          const chat        = model.startChat({ history });
          const lastMessage = recentMessages[recentMessages.length - 1];
          const result      = await chat.sendMessage(lastMessage.parts[0].text);
          let text          = result.response.text().replace(/\*/g, "");

          if (!text || text.trim().length === 0) throw new Error("EMPTY_RESPONSE");

          // نجح — أرجع الرد مباشرة
          console.log(`✅ طارق نجح بالمفتاح ${keyIndex + 1}`);
          return text;

        } catch (error: any) {
          lastError = error;
          const msg = error?.message || String(error);
          const isQuota = msg.includes("quota") || msg.includes("429") || msg.includes("rate") || msg.includes("RESOURCE_EXHAUSTED");

          if (isQuota) {
            // الحصة نفدت — جرب المفتاح الجاي
            console.log(`⚠️ المفتاح ${keyIndex + 1} نفد، ننتقل للمفتاح ${keyIndex + 2}...`);
            continue;
          }

          // خطأ مختلف — وقف مباشرة
          break;
        }
      }

      throw lastError;

    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error("Tariq error:", msg);
      if (msg.includes("404") || msg.includes("MODEL"))                         return "خلل في موديل الذكاء الاصطناعي، تواصل مع المطور.";
      if (msg.includes("API_KEY") || msg.includes("401") || msg.includes("403")) return "مفتاح Gemini منتهي أو غلط، تواصل مع المطور.";
      if (msg.includes("quota") || msg.includes("429") || msg.includes("rate"))  return "طارق مشغول هسه، انتظر دقيقة وحاول مرة ثانية 😄";
      return "صار خلل فني، حاول مرة ثانية عيوني.";
    }
  },

  analyzeProduct: async (identifier: string, merchantId: number): Promise<string> => {
    const messages: ChatMessage[] = [{ role: "user", parts: [{ text: `حلل لي هذا المنتج: ${identifier}` }] }];
    return tariqAssistant.chat(messages, merchantId);
  },
};
