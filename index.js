require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// ================= INIT =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = String(process.env.RUNNER_GROUP_ID);

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

    return bot.sendMessage(userId,
`👋 Welcome to Helply!

Please accept Terms & Conditions to continue.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept", callback_data: "accept_terms" }],
            [{ text: "❌ Decline", callback_data: "decline_terms" }]
          ]
        }
      }
    );
  }

  return bot.sendMessage(userId,
`👋 Welcome back!

Send your request 🚀
(Type /terms to view terms again)`);
});

// ================= TERMS COMMAND =================
bot.onText(/\/terms/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📜 Helply Terms:

• Payment must be made before task starts  
• Helply charges 10% (5% user + 5% runner)  
• No fraud or abuse  
• Respect runners`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: "accept_terms" }]
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

  if (text.startsWith("/")) return;

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  // 🔥 FORCE TERMS BEFORE REQUEST
  if (!user || !user.accepted_terms) {
    return bot.sendMessage(userId,
`📜 You must accept Terms & Conditions first`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept", callback_data: "accept_terms" }],
            [{ text: "❌ Decline", callback_data: "decline_terms" }]
          ]
        }
      }
    );
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
  const taskId = Date.now();

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
    console.log("❌ ORDER ERROR:", error);
    return bot.sendMessage(userId, "❌ Failed to create request");
  }

  await bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

  // ===== SEND TO GROUP =====
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
  } catch (err) {
    console.log("❌ GROUP ERROR:", err.message);
  }
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {

    // ===== ACCEPT TERMS =====
    if (data === "accept_terms") {
      await supabase
        .from("users")
        .update({ accepted_terms: true })
        .eq("id", userId);

      return bot.sendMessage(userId, "🎉 You're in!\nSend request 🚀");
    }

    if (data === "decline_terms") {
      return bot.sendMessage(userId, "❌ You must accept terms.");
    }

    // ===== START OFFER =====
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");
      const base = Number(price);

      return bot.sendMessage(userId,
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

    // ===== ADJUST =====
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
          callback_data: `accept_${o.id}`
        }
      ]);

      return bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });
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
      const userPays = Math.ceil(agreed * 1.05);
      const runnerGets = Math.floor(agreed * 0.95);

      await supabase
        .from("orders")
        .update({
          runner_id: o.runner_id,
          agreed_price: agreed,
          total_price: userPays,
          runner_payout: runnerGets,
          payment_status: "pending",
          status: "matched"
        })
        .eq("id", Number(o.order_id));

      const link = `https://courageous-connection-production-3317.up.railway.app/create-payment?orderId=${o.order_id}`;

      await bot.sendMessage(o.user_id,
`💳 Payment

Service: ₦${agreed}
Total: ₦${userPays}

Pay:
${link}`);

      await bot.sendMessage(o.runner_id,
`🎉 Task accepted

You’ll receive ₦${runnerGets}`);
    }

  } catch (err) {
    console.log("❌ ERROR:", err.message);
  }
});
