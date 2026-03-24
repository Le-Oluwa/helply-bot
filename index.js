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

// 🔥 STATE
const priceState = {};
const offerMessages = {};

console.log("🚀 Helply Running");


// ================= USER REQUEST =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text.trim();

  // ================= PRICE INPUT =================
  if (priceState[userId]) {

    const price = parseInt(text);

    if (isNaN(price) || price < 100) {
      return bot.sendMessage(userId, "❌ Enter a valid price (e.g. 500)");
    }

    const taskId = priceState[userId].taskId;

    // 🔥 SAVE OFFER
    const { error } = await supabase.from("offers").insert([{
      id: uuidv4(),
      order_id: taskId,
      runner_id: userId.toString(),
      runner_name: msg.from.first_name,
      price
    }]);

    if (error) {
      console.log("❌ OFFER ERROR:", error);
      return bot.sendMessage(userId, "❌ Failed to save offer.");
    }

    console.log("✅ OFFER SAVED");

    // 🔥 GET ORDER
    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", taskId)
      .single();

    if (!order) {
      console.log("❌ ORDER NOT FOUND");
      return;
    }

    // 🔥 GET OFFERS
    const { data: offers } = await supabase
      .from("offers")
      .select("*")
      .eq("order_id", taskId);

    console.log("📦 OFFERS:", offers);

    const chatId = parseInt(order.user_id, 10);

    if (offers && offers.length > 0) {
      offers.sort((a, b) => a.price - b.price);

      const buttons = offers.map(o => [
        {
          text: `👤 ${o.runner_name} — ₦${o.price}`,
          callback_data: `select_${taskId}_${o.id}_${o.price}`
        }
      ]);

      await bot.sendMessage(
        chatId,
        `💰 Available Offers (${offers.length})`,
        { reply_markup: { inline_keyboard: buttons } }
      );
    }

    delete priceState[userId];

    return bot.sendMessage(userId, "✅ Offer submitted!");
  }


  // ================= IGNORE COMMANDS =================
  if (text.startsWith("/")) return;

  // ================= NEW REQUEST =================
  if (msg.chat.type === "private") {

    const taskId = Math.random().toString(36).substring(2, 9);

    await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId.toString(),
      task: text,
      status: "negotiating",
      created_at: new Date()
    }]);

    bot.sendMessage(userId, `✅ Request sent\nTask ID: ${taskId}`);

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW REQUEST\n\n🆔 ${taskId}\n📌 ${text}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Make Offer", callback_data: `offer_${taskId}` }]
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

  console.log("📩 CALLBACK:", data);

  try {

    // ================= MAKE OFFER =================
    if (data.startsWith("offer_")) {
      await bot.answerCallbackQuery(query.id);

      const taskId = data.split("_")[1];

      priceState[userId] = { taskId };

      bot.sendMessage(
        userId,
        "💰 Send your price (e.g. 500)"
      );

      return;
    }


    // ================= SELECT OFFER =================
    if (data.startsWith("select_")) {
      await bot.answerCallbackQuery(query.id);

      const parts = data.split("_");

      const taskId = parts[1];
      const offerId = parts[2];
      const price = parseInt(parts[3]);

      await supabase.from("orders").update({
        status: "awaiting_payment",
        agreed_price: price
      }).eq("id", taskId);

      await supabase
        .from("offers")
        .delete()
        .eq("order_id", taskId)
        .neq("id", offerId);

      bot.sendMessage(userId, "✅ Offer selected!");
      return;
    }

  } catch (err) {
    console.log("❌ ERROR:", err.message);
  }
});


// ================= ERROR HANDLING =================
process.on("unhandledRejection", (err) => console.log("UNHANDLED:", err));
process.on("uncaughtException", (err) => console.log("UNCAUGHT:", err));