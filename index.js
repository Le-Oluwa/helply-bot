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

const ADMIN_ID = 123456789; // 🔥 replace with your Telegram ID

console.log("🚀 Helply Running");


// ================= ADMIN =================
bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  await bot.sendMessage(
    msg.from.id,
    "📊 Admin Dashboard",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Send Broadcast", callback_data: "admin_broadcast" }]
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

  // 🔥 SAVE USER (NEW)
  await supabase.from("users").upsert([{
    id: userId.toString(),
    banned: false
  }]);

  if (text.startsWith("/")) return;

  // ================= BROADCAST TRIGGER =================
  if (broadcastState[userId]) {
    const message = text;

    delete broadcastState[userId];

    return bot.sendMessage(
      userId,
      `✅ Broadcast message received:\n\n${message}`
    );
  }

  // ================= NEGOTIATION =================
  if (negotiationState[userId]) {
    const price = Number(text);
    const { offerId, role } = negotiationState[userId];

    const { data: offer } = await supabase
      .from("offers")
      .select("*")
      .eq("id", offerId)
      .maybeSingle();

    if (!offer) return;

    await supabase
      .from("offers")
      .update({
        current_price: price,
        last_actor: role
      })
      .eq("id", offerId);

    if (role === "user") {
      await bot.sendMessage(
        offer.runner_id,
        `💬 Customer countered: ₦${price}`
      );
    }

    if (role === "runner") {
      await bot.sendMessage(
        offer.user_id,
        `💬 Runner countered: ₦${price}`
      );
    }

    delete negotiationState[userId];
    return;
  }

  // ================= CREATE ORDER =================
  if (msg.chat.type === "private") {
    const taskId = Date.now();

    const { error } = await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId.toString(),
      delivery_location: text,
      status: "open",
      created_at: new Date()
    }]);

    if (error) {
      console.log("❌ ORDER ERROR:", error);
      return bot.sendMessage(userId, "❌ Failed to create request.");
    }

    bot.sendMessage(
      userId,
      `✅ Request sent\n🆔 ${taskId}`
    );

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW REQUEST\n🆔 ${taskId}\n📌 ${text}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Make Offer", callback_data: `offer_${taskId}_500` }]
          ]
        }
      }
    );
  }
});


// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;

  try {

    // ================= ADMIN BROADCAST BUTTON =================
    if (data === "admin_broadcast") {
      if (userId !== ADMIN_ID) return;

      broadcastState[userId] = true;

      return bot.sendMessage(
        userId,
        "📢 Type your broadcast message:"
      );
    }

    // ================= OFFER =================
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");

      await bot.sendMessage(userId, `💰 Price: ₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕100", callback_data: `price_${taskId}_${+price+100}` }],
            [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
          ]
        }
      });
    }

    // ================= SUBMIT OFFER =================
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
        runner_name: query.from.first_name,
        price: Number(price),
        current_price: Number(price),
        last_actor: "runner",
        created_at: new Date()
      }]);

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId));

      const buttons = offers.map(o => [
        {
          text: `${o.runner_name} - ₦${o.current_price}`,
          callback_data: `view_${o.id}`
        }
      ]);

      await bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });

      return bot.sendMessage(userId, "✅ Offer sent");
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});