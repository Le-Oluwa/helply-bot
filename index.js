require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// ================= INIT =================
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 300, autoStart: true }
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = String(process.env.RUNNER_GROUP_ID);

console.log("🚀 Helply Running");
console.log("📡 GROUP:", RUNNER_GROUP_ID);

// ================= START (TERMS) =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();

  console.log("👤 START:", userId);

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  // Create user if not exists
  if (!user) {
    await supabase.from("users").insert([{
      id: userId,
      accepted_terms: false,
      banned: false
    }]);

    user = { accepted_terms: false };
  }

  // Skip if already accepted
  if (user.accepted_terms) {
    return bot.sendMessage(userId, "👋 Welcome back!\nSend your request 🚀");
  }

  // Show terms
  return bot.sendMessage(
    userId,
`👋 Welcome to Helply!

Please accept our Terms & Conditions to continue.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: "accept_terms" }],
          [{ text: "❌ Decline", callback_data: "decline_terms" }]
        ]
      }
    }
  );
});

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  console.log("📩 MESSAGE:", text);

  if (text.startsWith("/")) return;

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  // Block if no terms
  if (!user || !user.accepted_terms) {
    console.log("❌ TERMS NOT ACCEPTED");
    return bot.sendMessage(userId, "⚠️ Please send /start and accept terms");
  }

  // ===== ACTIVE CHAT =====
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

    return bot.sendMessage(receiver, `💬 ${text}`);
  }

  // ===== CREATE ORDER =====
  console.log("📦 Creating order...");

  const taskId = Date.now() + Math.floor(Math.random() * 1000);

  const { error } = await supabase
    .from("orders")
    .insert([{
      id: taskId,
      user_id: userId,
      delivery_location: text,
      status: "open",
      payment_status: "pending"
    }]);

  if (error) {
    console.error("❌ ORDER ERROR:", error);
    return bot.sendMessage(userId, "❌ Failed to create request");
  }

  console.log("✅ ORDER CREATED:", taskId);

  await bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

  // ===== SEND TO GROUP =====
  console.log("📤 Sending to group...");

  try {
    await bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW REQUEST

🆔 ${taskId}
📌 ${text}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Make Offer", callback_data: `offer_${taskId}_500` }]
          ]
        }
      }
    );

    console.log("✅ SENT TO GROUP");
  } catch (err) {
    console.error("❌ GROUP ERROR:", err.response?.body || err.message);
  }
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {

    // ===== ACCEPT TERMS =====
    if (data === "accept_terms") {
      await bot.answerCallbackQuery(q.id);

      await supabase
        .from("users")
        .update({ accepted_terms: true })
        .eq("id", userId);

      return bot.sendMessage(userId, "🎉 You're in!\nSend your request 🚀");
    }

    if (data === "decline_terms") {
      return bot.sendMessage(userId, "❌ You must accept terms.");
    }

    // ===== START OFFER =====
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");
      const base = Number(price);

      return bot.sendMessage(
        userId,
`💰 Set your offer

₦${base}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "-50", callback_data: `adj_${taskId}_${base}_-50` },
                { text: "+50", callback_data: `adj_${taskId}_${base}_50` }
              ],
              [
                { text: "-100", callback_data: `adj_${taskId}_${base}_-100` },
                { text: "+100", callback_data: `adj_${taskId}_${base}_100` }
              ],
              [
                { text: "-500", callback_data: `adj_${taskId}_${base}_-500` },
                { text: "+500", callback_data: `adj_${taskId}_${base}_500` }
              ],
              [
                { text: "-1000", callback_data: `adj_${taskId}_${base}_-1000` },
                { text: "+1000", callback_data: `adj_${taskId}_${base}_1000` }
              ],
              [
                { text: "✅ Submit", callback_data: `submit_${taskId}_${base}` }
              ]
            ]
          }
        }
      );
    }

    // ===== ADJUST PRICE =====
    if (data.startsWith("adj_")) {
      const [_, taskId, current, change] = data.split("_");

      let newPrice = Number(current) + Number(change);
      if (newPrice < 100) newPrice = 100;

      return bot.editMessageText(
`💰 Set your offer

₦${newPrice}`,
        {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "-50", callback_data: `adj_${taskId}_${newPrice}_-50` },
                { text: "+50", callback_data: `adj_${taskId}_${newPrice}_50` }
              ],
              [
                { text: "-100", callback_data: `adj_${taskId}_${newPrice}_-100` },
                { text: "+100", callback_data: `adj_${taskId}_${newPrice}_100` }
              ],
              [
                { text: "-500", callback_data: `adj_${taskId}_${newPrice}_-500` },
                { text: "+500", callback_data: `adj_${taskId}_${newPrice}_500` }
              ],
              [
                { text: "-1000", callback_data: `adj_${taskId}_${newPrice}_-1000` },
                { text: "+1000", callback_data: `adj_${taskId}_${newPrice}_1000` }
              ],
              [
                { text: "✅ Submit", callback_data: `submit_${taskId}_${newPrice}` }
              ]
            ]
          }
        }
      );
    }

    // ===== SUBMIT OFFER =====
    if (data.startsWith("submit_")) {
      const [_, taskId, price] = data.split("_");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(taskId))
        .maybeSingle();

      if (!order) return;

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

    // ===== ACCEPT OFFER =====
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (!o) return;

      const agreed = Number(o.current_price);
      const userPays = Math.ceil(agreed * 1.05);

      await supabase
        .from("orders")
        .update({
          runner_id: o.runner_id,
          agreed_price: agreed,
          total_price: userPays,
          payment_status: "pending",
          status: "matched"
        })
        .eq("id", Number(o.order_id));

      const link = `https://courageous-connection-production-3317.up.railway.app/create-payment?orderId=${o.order_id}`;

      await bot.sendMessage(o.user_id,
`💳 Payment

Service: ₦${agreed}
Total: ₦${userPays}

Pay here:
${link}`);

      await bot.sendMessage(o.runner_id,
`🎉 Task assigned

You will be paid after completion`);
    }

  } catch (err) {
    console.log("❌ ERROR:", err.message);
  }
});
