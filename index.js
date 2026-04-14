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

const negotiationState = {};
const broadcastState = {};

console.log("🚀 Helply Running");


// ================= START (TERMS) =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId.toString())
    .maybeSingle();

  if (user?.accepted_terms) {
    return bot.sendMessage(userId, "👋 Welcome back to Helply!");
  }

  return bot.sendMessage(
    userId,
`👋 Welcome to Helply!

📜 Terms & Conditions

• Provide accurate requests  
• No illegal or harmful use  
• Be respectful to runners  
• No bypassing the platform  
• Abuse may lead to ban  

Do you accept?`,
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

  const userId = msg.from.id;
  const text = msg.text.trim();

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId.toString())
    .maybeSingle();

  // ===== FIRST TIME USER =====
  if (!user) {
    await supabase.from("users").insert([{
      id: userId.toString(),
      accepted_terms: false,
      banned: false
    }]);

    return bot.sendMessage(
      userId,
      "⚠️ Please type /start and accept the terms first."
    );
  }

  // ===== BLOCK IF NOT ACCEPTED =====
  if (user.accepted_terms === false) {
    return bot.sendMessage(
      userId,
      "⚠️ Please use /start and accept the terms first."
    );
  }

  if (text.startsWith("/")) return;

  // ===== NEGOTIATION =====
  if (negotiationState[userId]) {
    const price = Number(text);
    const { offerId, role } = negotiationState[userId];

    const { data: offer } = await supabase
      .from("offers")
      .select("*")
      .eq("id", offerId)
      .maybeSingle();

    await supabase.from("offers").update({
      current_price: price,
      last_actor: role
    }).eq("id", offerId);

    if (role === "user") {
      await bot.sendMessage(
        offer.runner_id,
        `💬 Customer countered: ₦${price}`
      );
    } else {
      await bot.sendMessage(
        offer.user_id,
        `💬 Runner countered: ₦${price}`
      );
    }

    delete negotiationState[userId];
    return;
  }

  // ===== CREATE ORDER =====
  const taskId = Date.now();

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId.toString(),
    delivery_location: text,
    status: "open"
  }]);

  await bot.sendMessage(
    userId,
    `✅ Request sent\n🆔 ${taskId}`
  );

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
  const userId = q.from.id;

  try {

    // ===== ACCEPT TERMS =====
    if (data === "accept_terms") {
      await supabase.from("users").upsert([{
        id: userId.toString(),
        accepted_terms: true,
        banned: false
      }]);

      return bot.sendMessage(
        userId,
        "✅ Terms accepted!\n\nYou can now send your request."
      );
    }

    // ===== DECLINE TERMS =====
    if (data === "decline_terms") {
      return bot.sendMessage(
        userId,
        "❌ You must accept the terms to use Helply."
      );
    }

    // ===== OFFER =====
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");

      return bot.sendMessage(
        userId,
        `₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "+100", callback_data: `price_${taskId}_${+price+100}` }],
              [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
            ]
          }
        }
      );
    }

    // ===== PRICE UPDATE =====
    if (data.startsWith("price_")) {
      const [_, taskId, price] = data.split("_");

      return bot.sendMessage(
        userId,
        `₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "+100", callback_data: `price_${taskId}_${+price+100}` }],
              [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
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

      await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: String(taskId),
        user_id: order.user_id,
        runner_id: userId.toString(),
        runner_name: q.from.first_name,
        current_price: Number(price),
        last_actor: "runner"
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

    // ===== VIEW OFFER =====
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      return bot.sendMessage(
        userId,
        `${o.runner_name} — ₦${o.current_price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Accept", callback_data: `accept_${id}` }],
              [{ text: "Counter", callback_data: `counter_user_${id}` }]
            ]
          }
        }
      );
    }

    // ===== COUNTER =====
    if (data.startsWith("counter_user_")) {
      negotiationState[userId] = {
        offerId: data.split("_")[2],
        role: "user"
      };
      return bot.sendMessage(userId, "Enter your price:");
    }

    if (data.startsWith("counter_runner_")) {
      negotiationState[userId] = {
        offerId: data.split("_")[2],
        role: "runner"
      };
      return bot.sendMessage(userId, "Enter your price:");
    }

    // ===== ACCEPT (NO PAYMENT YET) =====
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      await bot.sendMessage(o.user_id, "✅ Offer accepted!");
      await bot.sendMessage(o.runner_id, "🎉 You got the task!");

      await supabase.from("orders").update({
        runner_id: o.runner_id,
        status: "assigned"
      }).eq("id", Number(o.order_id));
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});