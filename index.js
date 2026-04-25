require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

console.log("🚀 Helply Running");


// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user) {
    await supabase.from("users").insert([{
      id: userId,
      accepted_terms: false,
      banned: false
    }]);
    user = { accepted_terms: false };
  }

  if (user.accepted_terms) {
    return bot.sendMessage(userId, "👋 Welcome back to Helply!");
  }

  return bot.sendMessage(userId,
`👋 Welcome to Helply!

Do you accept terms?`,
{
  reply_markup: {
    inline_keyboard: [
      [{ text: "✅ Accept", callback_data: "accept_terms" }],
      [{ text: "❌ Decline", callback_data: "decline_terms" }]
    ]
  }
});
});


// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user || !user.accepted_terms) {
    return bot.sendMessage(userId, "⚠️ Use /start first.");
  }

  if (text.startsWith("/")) return;

  // ===== CHAT AFTER PAYMENT =====
  const { data: activeOrder } = await supabase
    .from("orders")
    .select("*")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .eq("payment_status", "paid")
    .eq("status", "in_progress")
    .maybeSingle();

  if (activeOrder) {
    const receiver =
      userId === activeOrder.user_id
        ? activeOrder.runner_id
        : activeOrder.user_id;

    return bot.sendMessage(
      receiver,
      `💬 ${userId === activeOrder.user_id ? "Customer" : "Runner"}:\n${text}`
    );
  }

  // ===== CREATE ORDER =====
  const taskId = Date.now();

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId,
    delivery_location: text,
    status: "open"
  }]);

  await bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

  await bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 NEW REQUEST\n🆔 ${taskId}\n📌 ${text}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Offer", callback_data: `offer_${taskId}_500` }]
        ]
      }
    }
  );
});


// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {

    // ===== TERMS =====
    if (data === "accept_terms") {
      await supabase.from("users").upsert([{
        id: userId,
        accepted_terms: true
      }]);

      return bot.sendMessage(userId, "✅ You can now use Helply!");
    }

    if (data === "decline_terms") {
      return bot.sendMessage(userId, "❌ You must accept terms.");
    }

    // ===== OFFER START =====
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(taskId))
        .maybeSingle();

      if (order.user_id === userId) {
        return bot.answerCallbackQuery(q.id, {
          text: "❌ You can't run your own task",
          show_alert: true
        });
      }

      return bot.sendMessage(userId, `₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "+100", callback_data: `price_${taskId}_${+price+100}` }],
            [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
          ]
        }
      });
    }

    // ===== SUBMIT OFFER =====
    if (data.startsWith("submit_")) {
      const [_, taskId, price] = data.split("_");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(taskId))
        .maybeSingle();

      await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: String(taskId),
        user_id: order.user_id,
        runner_id: userId,
        runner_name: q.from.first_name,
        current_price: Number(price)
      }]);

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId));

      const buttons = offers.map(o => [
        {
          text: `${o.runner_name} — ₦${o.current_price}`,
          callback_data: `view_${o.id}`
        }
      ]);

      return bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    // ===== VIEW OFFER (WITH BUTTON NEGOTIATION) =====
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (!o) return;

      return bot.sendMessage(userId,
        `${o.runner_name} — ₦${o.current_price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `accept_${id}` }],
              [
                { text: "-50", callback_data: `adj_${id}_-50` },
                { text: "+50", callback_data: `adj_${id}_50` }
              ],
              [
                { text: "-100", callback_data: `adj_${id}_-100` },
                { text: "+100", callback_data: `adj_${id}_100` }
              ],
              [
                { text: "-500", callback_data: `adj_${id}_-500` },
                { text: "+500", callback_data: `adj_${id}_500` }
              ],
              [
                { text: "-1000", callback_data: `adj_${id}_-1000` },
                { text: "+1000", callback_data: `adj_${id}_1000` }
              ]
            ]
          }
        });
    }

    // ===== PRICE ADJUST =====
    if (data.startsWith("adj_")) {
      const [_, offerId, change] = data.split("_");

      const delta = Number(change);

      const { data: offer } = await supabase
        .from("offers")
        .select("*")
        .eq("id", offerId)
        .maybeSingle();

      if (!offer) return;

      let newPrice = Number(offer.current_price) + delta;

      if (newPrice < 100) newPrice = 100;

      await supabase
        .from("offers")
        .update({ current_price: newPrice })
        .eq("id", offerId);

      await bot.sendMessage(offer.user_id, `💬 Price updated: ₦${newPrice}`);
      await bot.sendMessage(offer.runner_id, `💬 Price updated: ₦${newPrice}`);

      return bot.sendMessage(userId, `Updated: ₦${newPrice}`);
    }

    // ===== ACCEPT =====
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (!o) return;

      const agreed = Number(o.current_price);

      if (!agreed || agreed <= 0) {
        return bot.sendMessage(userId, "❌ Invalid price.");
      }

      const userPays = Math.ceil(agreed * 1.05);
      const runnerGets = Math.floor(agreed * 0.95);
      const fee = userPays - runnerGets;

      await supabase
        .from("orders")
        .update({
          runner_id: o.runner_id,
          agreed_price: agreed,
          total_price: userPays,
          runner_payout: runnerGets,
          platform_fee: fee,
          payment_status: "pending",
          status: "matched"
        })
        .eq("id", Number(o.order_id));

      const link = `https://courageous-connection-production-3317.up.railway.app/create-payment?orderId=${o.order_id}`;

      await bot.sendMessage(o.user_id,
`✅ Accepted!

Service: ₦${agreed}
Fee: ₦${fee}
Total: ₦${userPays}

Pay:
${link}`);

      await bot.sendMessage(o.runner_id,
`🎉 Accepted!

You will receive ₦${runnerGets}
Waiting for payment...`);
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});
