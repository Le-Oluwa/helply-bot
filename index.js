require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

// 🔥 STATE (per runner per task)
const priceState = {};

console.log("🚀 Helply Running");


// ================= USER REQUEST =================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.chat.id;
  const taskText = msg.text;

  const taskId = Math.random().toString(36).substring(2, 9);

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId.toString(),
    task: taskText,
    status: "negotiating",
    created_at: new Date()
  }]);

  bot.sendMessage(userId, `✅ Request sent\nTask ID: ${taskId}`);

  bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 NEW REQUEST\n\n🆔 ${taskId}\n📌 ${taskText}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Make Offer", callback_data: `offer_${taskId}` }]
        ]
      }
    }
  );
});


// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;

  try {

    // ================= MAKE OFFER =================
    if (data.startsWith("offer_")) {
      const taskId = data.split("_")[1];
      const key = `${userId}_${taskId}`;

      priceState[key] = { taskId, price: 500 };

      bot.sendMessage(userId, `💰 Set your price: ₦500`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➖100", callback_data: `minus_${taskId}` },
              { text: "➕100", callback_data: `plus_${taskId}` }
            ],
            [
              { text: "➖500", callback_data: `minus500_${taskId}` },
              { text: "➕500", callback_data: `plus500_${taskId}` }
            ],
            [
              { text: "✅ Submit Offer", callback_data: `submit_${taskId}` }
            ]
          ]
        }
      });

      return bot.answerCallbackQuery(query.id);
    }


    // ================= PRICE CONTROL =================
    if (
      data.startsWith("plus_") ||
      data.startsWith("minus_") ||
      data.startsWith("plus500_") ||
      data.startsWith("minus500_")
    ) {
      const taskId = data.split("_")[1];
      const key = `${userId}_${taskId}`;

      if (!priceState[key]) return;

      if (data.startsWith("plus_")) priceState[key].price += 100;
      if (data.startsWith("minus_")) priceState[key].price -= 100;
      if (data.startsWith("plus500_")) priceState[key].price += 500;
      if (data.startsWith("minus500_")) priceState[key].price -= 500;

      priceState[key].price = Math.max(100, priceState[key].price);

      bot.editMessageText(`💰 Set your price: ₦${priceState[key].price}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: query.message.reply_markup
      });

      return bot.answerCallbackQuery(query.id);
    }


    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {

      // 🔥 GET STATE SAFELY (no mismatch)
      const stateEntry = Object.entries(priceState).find(([k]) =>
        k.startsWith(userId + "_")
      );

      if (!stateEntry) {
        return bot.sendMessage(userId, "⚠️ Session expired.");
      }

      const key = stateEntry[0];
      const { taskId, price } = stateEntry[1];

      await supabase.from("offers").insert([{
        order_id: taskId,
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price
      }]);

      console.log("✅ OFFER SAVED FOR:", taskId);

      // 🔥 FETCH ORDER (SAFE)
      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId);

      if (!orders || orders.length === 0) {
        console.log("❌ Order not found");
        return;
      }

      const order = orders[0];

      // 🔥 SEND VIEW BUTTON
      bot.sendMessage(
        order.user_id,
        "💰 New offer received!",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "👀 View Offers", callback_data: `view_${taskId}` }]
            ]
          }
        }
      );

      delete priceState[key];

      bot.sendMessage(userId, "✅ Offer submitted!");

      return bot.answerCallbackQuery(query.id);
    }


    // ================= VIEW OFFERS =================
    if (data.startsWith("view_")) {

      const taskId = data.split("_")[1];

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", taskId);

      if (!offers || offers.length === 0) {
        return bot.sendMessage(userId, "❌ No offers yet.");
      }

      offers.sort((a, b) => a.price - b.price);

      const buttons = offers.map(o => [
        {
          text: `👤 ${o.runner_name} — ₦${o.price}`,
          callback_data: `select_${taskId}_${o.id}_${o.price}`
        }
      ]);

      bot.sendMessage(
        userId,
        `💰 Available Offers (${offers.length})`,
        {
          reply_markup: { inline_keyboard: buttons }
        }
      );

      return bot.answerCallbackQuery(query.id);
    }


    // ================= SELECT OFFER =================
    if (data.startsWith("select_")) {

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

      return bot.answerCallbackQuery(query.id);
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});