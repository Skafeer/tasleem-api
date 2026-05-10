import { db } from "./db";
import { products, orders, orderItems, withdrawals, users } from "@shared/schema";
import { eq, sql, and, desc, gte, lt } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3,
  process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5,
].filter(Boolean) as string[];

if (GEMINI_KEYS.length === 0) console.warn("no GEMINI_KEY");
const GEMINI_MODEL = "models/gemini-2.5-flash-lite";

export type ChatMessage = { role: "user" | "model"; parts: [{ text: string }]; };

async function getMerchantContext(merchantId: number): Promise<string> {
  try {
    const merchantData = await db
      .select({ storeName: users.storeName, balance: users.balance, pendingBalance: users.pendingBalance, createdAt: users.createdAt })
      .from(users).where(eq(users.id, merchantId)).limit(1);
    const merchant = merchantData[0];
    if (!merchant) return "لا توجد بيانات للتاجر.";

    const now = new Date();
    const startOfThisWeek  = new Date(now); startOfThisWeek.setDate(now.getDate() - now.getDay()); startOfThisWeek.setHours(0,0,0,0);
    const startOfLastWeek  = new Date(startOfThisWeek); startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0);

    const allOrders = await db
      .select({ id: orders.id, status: orders.status, totalProfit: orders.totalProfit, totalAmount: orders.totalAmount, shippingCost: orders.shippingCost, createdAt: orders.createdAt })
      .from(orders).where(eq(orders.merchantId, merchantId)).orderBy(desc(orders.createdAt));

    const totalOrders     = allOrders.length;
    const pendingOrders   = allOrders.filter(o => o.status === "pending").length;
    const deliveredOrders = allOrders.filter(o => o.status === "delivered").length;
    const cancelledOrders = allOrders.filter(o => o.status === "cancelled").length;
    const thisMonthProfit = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfThisMonth && o.status === "delivered").reduce((s,o) => s + (o.totalProfit||0), 0);
    const lastMonthProfit = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfLastMonth && new Date(o.createdAt) <= endOfLastMonth && o.status === "delivered").reduce((s,o) => s + (o.totalProfit||0), 0);
    const thisWeekCount   = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfThisWeek).length;
    const lastWeekCount   = allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= startOfLastWeek && new Date(o.createdAt) < startOfThisWeek).length;
    const totalProfit     = allOrders.filter(o => o.status === "delivered").reduce((s,o) => s + (o.totalProfit||0), 0);
    const weekChange      = lastWeekCount > 0 ? (((thisWeekCount - lastWeekCount) / lastWeekCount) * 100).toFixed(0) : null;

    const topProductsRaw = await db.execute(sql`
      SELECT p.id, p.name, p.description, p.stock, p.wholesale_price, p.suggested_price, p.discount,
             COALESCE(SUM(oi.quantity), 0) as total_sold
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.merchant_id = ${merchantId} AND o.status = 'delivered'
      GROUP BY p.id, p.name, p.description, p.stock, p.wholesale_price, p.suggested_price, p.discount
      ORDER BY total_sold DESC LIMIT 5`);

    const merchantProductsRaw = await db.execute(sql`
      SELECT DISTINCT p.id, p.name, p.stock, p.wholesale_price, p.suggested_price, p.discount, p.is_active
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.merchant_id = ${merchantId} LIMIT 20`);
    const merchantProducts   = merchantProductsRaw.rows as any[];
    const lowStockProducts   = merchantProducts.filter((p:any) => p.stock > 0 && p.stock <= 10);
    const outOfStockProducts = merchantProducts.filter((p:any) => p.stock === 0);

    const pendingOrdersDetail = allOrders.filter(o => o.status === "pending").slice(0,5)
      .map(o => `طلب #${o.id} (منذ ${o.createdAt ? Math.floor((now.getTime()-new Date(o.createdAt).getTime())/3600000) : 0} ساعة)`);

    // ── آخر 10 طلبات مع تفاصيل الربح الكاملة ──
    const recentOrdersDetail = allOrders.slice(0,10).map(o => {
      const hoursAgo  = o.createdAt ? Math.floor((now.getTime()-new Date(o.createdAt).getTime())/3600000) : 0;
      const timeStr   = hoursAgo > 24 ? `منذ ${Math.floor(hoursAgo/24)} يوم` : `منذ ${hoursAgo} ساعة`;
      const statusStr = o.status==='delivered' ? 'تم التوصيل' : o.status==='pending' ? 'معلق' : 'ملغي';
      const profit    = o.totalProfit ?? 0;
      const shipping  = (o as any).shippingCost ?? 0;
      const amount    = o.totalAmount ?? 0;
      return `طلب #${o.id} | ${statusStr} | مبلغ_الطلب_الكلي: ${amount.toLocaleString()}د.ع | توصيل: ${shipping.toLocaleString()}د.ع | ربح_التاجر_الفعلي: ${profit.toLocaleString()}د.ع | ${timeStr}`;
    });

    const lastWithdrawal = await db.select().from(withdrawals).where(eq(withdrawals.merchantId, merchantId)).orderBy(desc(withdrawals.createdAt)).limit(1);

    const rankingRaw = await db.execute(sql`
      SELECT merchant_id, SUM(total_profit) as total_profit FROM orders
      WHERE status='delivered' AND created_at>=${startOfThisMonth.toISOString()}
      GROUP BY merchant_id ORDER BY total_profit DESC`);
    const ranking        = rankingRaw.rows as any[];
    const merchantRank   = ranking.findIndex((r:any) => r.merchant_id === merchantId) + 1;
    const totalMerchants = ranking.length;

    const suggestedRaw = await db.execute(sql`
      SELECT p.id, p.name, p.description, p.stock, p.suggested_price, p.wholesale_price, p.discount, p.category
      FROM products p WHERE p.is_active=TRUE AND p.stock>20
        AND p.id NOT IN (SELECT DISTINCT oi.product_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.merchant_id=${merchantId})
      ORDER BY p.stock DESC LIMIT 5`);

    const allProdRaw = await db.execute(sql`
      SELECT p.id, p.name, p.description, p.stock, p.suggested_price, p.wholesale_price, p.discount, p.category, p.selling_price_min
      FROM products p WHERE p.is_active=TRUE ORDER BY p.id ASC LIMIT 100`);
    const allProds = allProdRaw.rows as any[];

    const profitTxt = lastMonthProfit > 0
      ? thisMonthProfit > lastMonthProfit
        ? `📈 أعلى بـ ${((thisMonthProfit-lastMonthProfit)/lastMonthProfit*100).toFixed(0)}%`
        : `📉 أقل بـ ${((lastMonthProfit-thisMonthProfit)/lastMonthProfit*100).toFixed(0)}%`
      : "أول شهر";
    const weekTxt = weekChange !== null
      ? Number(weekChange) >= 0 ? `📈 +${weekChange}%` : `📉 ${weekChange}%`
      : "أول أسبوع";

    return `
━━━ بيانات التاجر ━━━
الاسم: ${merchant.storeName}
الرصيد المتاح: ${(merchant.balance||0).toLocaleString()} د.ع | المعلق: ${(merchant.pendingBalance||0).toLocaleString()} د.ع
${lastWithdrawal[0] ? `آخر سحب: ${(lastWithdrawal[0] as any).amount?.toLocaleString()} د.ع (${(lastWithdrawal[0] as any).status==='completed'?'مكتمل':'معلق'})` : 'لا يوجد سحب سابق'}

━━━ الأداء ━━━
الطلبات: ${totalOrders} | مكتمل: ${deliveredOrders} | معلق: ${pendingOrders} | ملغي: ${cancelledOrders}
إجمالي الأرباح: ${totalProfit.toLocaleString()} د.ع
هذا الشهر: ${thisMonthProfit.toLocaleString()} د.ع | الشهر الماضي: ${lastMonthProfit.toLocaleString()} د.ع (${profitTxt})
هذا الأسبوع: ${thisWeekCount} طلب | الماضي: ${lastWeekCount} (${weekTxt})
${merchantRank > 0 ? `الترتيب: #${merchantRank} من ${totalMerchants} تاجر` : ''}

━━━ الطلبات المعلقة ━━━
${pendingOrders===0 ? 'لا توجد ✅' : pendingOrdersDetail.join('\n')}

━━━ آخر الطلبات مع تفاصيل الربح ━━━
ملاحظة: ربح_التاجر_الفعلي = مبلغ_البيع - سعر_الجملة - كلفة_التوصيل (يحسبه النظام تلقائياً)
كلفة التوصيل: 5,000 د.ع للمحافظات العادية | 3,000 د.ع للبصرة
${recentOrdersDetail.join('\n')}

━━━ أكثر منتجاته مبيعاً ━━━
${(topProductsRaw.rows as any[]).length===0 ? 'لم يبع بعد' : (topProductsRaw.rows as any[]).map((p:any,i:number) => {
  const ws = (p.wholesale_price||0) * (p.discount>0 ? (1-p.discount/100) : 1);
  const pr = Math.max(0, (p.suggested_price||0) - ws);
  const d  = p.description ? ` | وصف: ${String(p.description).slice(0,2000)}` : '';
  return `${i+1}. ${p.name} | مباع: ${p.total_sold}ق | جملة: ${Math.round(ws).toLocaleString()}د.ع | مقترح: ${(p.suggested_price||0).toLocaleString()}د.ع | ربح_بالمقترح_بدون_توصيل: ${Math.round(pr).toLocaleString()}د.ع | مخزون: ${p.stock}${d}`;
}).join('\n')}

━━━ تحذيرات المخزون ━━━
${lowStockProducts.length===0 && outOfStockProducts.length===0 ? 'المخزون بخير ✅'
  : [...outOfStockProducts.map((p:any) => `❌ ${p.name} — نفد`), ...lowStockProducts.map((p:any) => `⚠️ ${p.name} — باقي ${p.stock}`)].join('\n')}

━━━ منتجات مقترحة ━━━
${(suggestedRaw.rows as any[]).length===0 ? 'جرب كل المنتجات!' : (suggestedRaw.rows as any[]).map((p:any) => {
  const ws = (p.wholesale_price||0) * (p.discount>0 ? (1-p.discount/100) : 1);
  const pr = Math.max(0, (p.suggested_price||0) - ws);
  const d  = p.description ? ` | وصف: ${String(p.description).slice(0,2000)}` : '';
  return `- ${p.name} (${p.category}) | جملة: ${Math.round(ws).toLocaleString()}د.ع | مقترح: ${(p.suggested_price||0).toLocaleString()}د.ع | ربح_بالمقترح_بدون_توصيل: ${Math.round(pr).toLocaleString()}د.ع | مخزون: ${p.stock}${d}`;
}).join('\n')}

━━━ كل منتجات المنصة ━━━
${allProds.map((p:any) => {
  const ws = (p.wholesale_price||0) * (p.discount>0 ? (1-p.discount/100) : 1);
  const pr = Math.max(0, (p.suggested_price||0) - ws);
  const d  = p.description ? `|وصف:${String(p.description).slice(0,2000)}` : '';
  return `ID:${p.id}|${p.name}|جملة:${Math.round(ws).toLocaleString()}د.ع|مقترح:${(p.suggested_price||0).toLocaleString()}د.ع|حد_أدنى:${(p.selling_price_min||0).toLocaleString()}د.ع|ربح_بالمقترح_بدون_توصيل:${Math.round(pr).toLocaleString()}د.ع|مخزون:${p.stock}|${p.category}${d}`;
}).join('\n')}
`.trim();
  } catch(err) {
    console.error("getMerchantContext error:", err);
    return "تعذر جلب بيانات التاجر.";
  }
}

function buildSystemPrompt(merchantContext: string): string {
  return `أنت "طارق"، المساعد الشخصي الموثوق للتجار في منصة "تسليم" للدروب شوبينج.

شخصيتك:
- تحجي بغدادي خالص — مثل أخ كبير يسولف مع أخوه الصغير بمحبة
- تنادي التاجر بـ "عيوني" أو "يا غالي" أو "يا بويه" أو "حبيبي" بشكل طبيعي ودافئ
- خفيف ومرح — تضحك معه وتشجعه، مو بس تعطيه أرقام
- لما يتعب أو ييأس — ترفع معنوياته بصدق وحرارة
- لما يربح — تفرح معه فرح حقيقي مو شكلي
- تستخدم إيموجي بشكل طبيعي — مو زيادة ومو قليلة
- إيموجي تسليم المميز هو 🧡 — استخدمه بنهاية رسائلك بدل أي قلب ثاني، لأنه يمثل هوية تسليم البرتقالية

أمثلة على اللهجة الصح:
- "هسه" مو "الحين"
- "شسالفة" مو "ما الأمر"
- "گلي" مو "قل لي"
- "چا" أو "لا چا" للتعجب
- "ولله" مو "والله"
- "شكد" مو "كم"
- "يمّه" أو "عيوني" للمديح
- "هواي" مو "كثير"
- "پارة" أو "فلوس" مو "نقود"
- "ماكو" مو "لا يوجد"
- "أكو" مو "يوجد"
- "گاعد" مو "يقوم بـ"
- "حتى" مو "عشان"
- "لو ما" مو "إذا لم"

قواعد الأسلوب:
- ممنوع النجمة (*) — استخدم الشرطة (-) للقوائم
- الأرقام واضحة دايماً بالدينار العراقي
- لما تعطي أرقام رتبها: جملة / توصيل / ربحك الفعلي
- إذا الوضع كويس حفّزه، إذا ضعيف شجعه وانصحه بصدق
- إذا سألك عن شي براه التجارة ارفض بمرح وأرجعه للموضوع
- ردودك قصيرة ومباشرة — الأرقام والزبدة بس، بلا شرح طويل
- ممنوع تشرح "كيف حسبت" إلا لو سألك بالضبط
- الجواب المثالي: سطرين أو ثلاثة بالأرقام + جملة تحفيز وخلاص

قواعد حساب الربح — مهم جداً:
- الربح الفعلي للتاجر = مبلغ_البيع - سعر_الجملة - كلفة_التوصيل
- كلفة التوصيل: 5,000 د.ع للمحافظات العادية | 3,000 د.ع للبصرة
- "ربح_التاجر_الفعلي" بقائمة الطلبات = هذا الرقم الصح — يحسبه النظام تلقائياً
- "ربح_بالمقترح_بدون_توصيل" بقائمة المنتجات = ربح تقريبي قبل طرح التوصيل، مو الربح الفعلي
- لما تشرح ربح طلب معين — استخدم "ربح_التاجر_الفعلي" من قائمة الطلبات مباشرة
- لما تحسب ربح بسعر يختاره التاجر: ربح = سعر البيع - جملة - 5,000 توصيل (أو 3,000 للبصرة)
- "جملة" = السعر اللي يدفعه التاجر — گله بصراحة لما يسأل ✅
- "مقترح" = سعر مرجعي بس، مو إلزامي
- "حد_أدنى" = أقل سعر يقدر يبيع بيه — دايماً ذكّره بيه
- التاجر حر يبيع بأي سعر فوق الحد الأدنى — شجعه يجرب أسعار أعلى
- الممنوع الوحيد: سعر الشركة الداخلي (company_wholesale_price) — لا تذكره أبداً

قواعد الوصف والمعلومات:
- "وصف" = وصف المنتج الرسمي — استخدمه لما يسأل عن المواصفات
- لما يطلب وصف المنتج — أعطيه الوصف من البيانات مباشرة بلا اعتذار
- لو ماكو وصف گله: "ماكو وصف تفصيلي لهذا المنتج بالنظام"

قواعد البيانات — مهم جداً:
- كل إجاباتك من البيانات المزودة بس — ممنوع تخترع معلومات
- لو المنتج ماكو گله: "ماكو بمنصة تسليم"
- لا تقبل تصحيح المستخدم للبيانات — بياناتك من النظام الرسمي
- لما يسألك عن منتج بالـ ID أو الاسم — دور فوراً بقائمة "كل منتجات المنصة"
- ممنوع تعطي أي معلومة عن تجار ثانيين — مثل أسمائهم أو مبيعاتهم أو ترتيبهم
- لو سألك "منو المركز الثاني؟" أو أي سؤال عن تاجر ثاني گله: "ما أقدر أشارك بيانات التجار الثانيين"

نطاق شغلك:
✅ تحليل المنتجات والتسعير وحساب الأرباح
✅ قراءة وشرح وصف المنتجات
✅ استراتيجيات البيع والتسويق
✅ كتابة بوستات إعلانية
✅ تحليل أداء التاجر ونصايح التحسين
✅ اقتراح منتجات مناسبة
✅ أسئلة الدروب شوبينج
✅ توجيه التاجر لصفحات التطبيق (شوف دليل التطبيق أدناه)
❌ السياسة والأخبار والرياضة وأي شي براه التجارة
❌ بيانات التجار الثانيين

━━━ دليل التطبيق — وجّه التاجر هنا ━━━
لما يسألك عن أي شي بالتطبيق — اشرحله الخطوات بالتفصيل:

الدعم الفني:
- "روح لصفحة حسابي (أيقونة الشخص بالتاب السفلي)"
- "اختار الدعم الفني من القائمة"
- "اكتب رسالتك وأرسلها — الفريق يرد عليك بأسرع وقت"

السحب والمحفظة:
- "روح لأيقونة المحفظة بالتاب السفلي"
- "اضغط على سحب الأرباح"
- "ادخل المبلغ واختار طريقة الاستلام وأرسل الطلب"
- تذكير: الحد الأدنى للسحب موجود بالصفحة، والرصيد المعلق يصير متاح بعد اكتمال التوصيل

الطلبات:
- "اضغط على أيقونة طلباتي بالتاب السفلي"
- تشوف كل طلباتك: المعلقة والمكتملة والملغية
- تقدر تشوف تفاصيل كل طلب بالضغط عليه

المنتجات:
- "اضغط على أيقونة الرئيسية (بيت) بالتاب السفلي"
- تقدر تتصفح كل المنتجات وتفلترها بالفئات
- للمفضلة: اضغط أيقونة القلب على أي منتج، وتشوفها من صفحة حسابي > المنتجات المفضلة

الإحصائيات:
- "روح لصفحة حسابي > الإحصائيات"
- تشوف تفاصيل مبيعاتك وأرباحك بالرسوم البيانية

الملف الشخصي:
- "روح لصفحة حسابي > الملف الشخصي"
- تقدر تعدل اسم المتجر ومعلوماتك

━━━ بيانات التاجر ━━━
${merchantContext}
━━━━━━━━━━━━━━━━━━━━━━

تصرف كأنك صاحب التاجر وتريد له الخير — سولفه بعراقي خالص.`;
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

      for (let keyIndex = 0; keyIndex < GEMINI_KEYS.length; keyIndex++) {
        const genAI = new GoogleGenerativeAI(GEMINI_KEYS[keyIndex]);
        try {
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt });
          let history = recentMessages.slice(0, -1);
          while (history.length > 0 && history[0].role !== 'user') history = history.slice(1);

          const chat   = model.startChat({ history });
          const result = await chat.sendMessage(recentMessages[recentMessages.length - 1].parts[0].text);
          let text     = result.response.text().replace(/\*/g, "");

          if (!text || text.trim().length === 0) throw new Error("EMPTY_RESPONSE");
          console.log(`✅ طارق نجح بالمفتاح ${keyIndex + 1}`);
          return text;

        } catch (error: any) {
          lastError = error;
          const msg     = error?.message || String(error);
          const isQuota = msg.includes("quota") || msg.includes("429") || msg.includes("rate") || msg.includes("RESOURCE_EXHAUSTED");
          if (isQuota) { console.log(`⚠️ المفتاح ${keyIndex+1} نفد`); continue; }
          break;
        }
      }
      throw lastError;

    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error("Tariq error:", msg);
      if (msg.includes("404") || msg.includes("MODEL"))                          return "خلل في موديل الذكاء الاصطناعي، تواصل مع المطور.";
      if (msg.includes("API_KEY") || msg.includes("401") || msg.includes("403")) return "مفتاح Gemini منتهي أو غلط، تواصل مع المطور.";
      if (msg.includes("quota") || msg.includes("429") || msg.includes("rate"))  return "طارق مشغول هسه، انتظر دقيقة وحاول مرة ثانية 😄";
      return "صار خلل فني، حاول مرة ثانية عيوني.";
    }
  },

  analyzeProduct: async (identifier: string, merchantId: number): Promise<string> => {
    return tariqAssistant.chat([{ role: "user", parts: [{ text: `حلل لي هذا المنتج: ${identifier}` }] }], merchantId);
  },
};
