require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

// price control state
const priceState = {};

console.log("🚀 Helply Button Negotiation Bot Running");


// ================= START =================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Welcome to Helply\n\nSend what you need.");
});


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

  bot.sendMessage(userId, `✅ Request sent.\nTask ID: ${taskId}`);

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

    // ================= START OFFER =================
    if (data.startsWith("offer_")) {

      const taskId = data.split("_")[1];

      priceState[userId] = {
        taskId,
        price: 500
      };

      bot.sendMessage(
        userId,
        `💰 Set your price: ₦500`,
        {
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
        }
      );

      return bot.answerCallbackQuery(query.id);
    }

    // ================= PRICE CONTROLS =================
    if (!priceState[userId]) return;

    if (data.startsWith("plus_")) {
      priceState[userId].price += 100;
    }

    if (data.startsWith("minus_")) {
      priceState[userId].price = Math.max(100, priceState[userId].price - 100);
    }

    if (data.startsWith("plus500_")) {
      priceState[userId].price += 500;
    }

    if (data.startsWith("minus500_")) {
      priceState[userId].price = Math.max(100, priceState[userId].price - 500);
    }

    // ================= UPDATE UI =================
    if (
      data.startsWith("plus_") ||
      data.startsWith("minus_") ||
      data.startsWith("plus500_") ||
      data.startsWith("minus500_")
    ) {

      const current = priceState[userId].price;

      bot.editMessageText(
        `💰 Set your price: ₦${current}`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: query.message.reply_markup
        }
      );

      return bot.answerCallbackQuery(query.id);
    }

    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {

      const taskId = data.split("_")[1];
      const price = priceState[userId].price;

      await supabase.from("offers").insert([{
        order_id: taskId,
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price
      }]);

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId)
        .single();

      if (order) {
        bot.sendMessage(order.user_id, `💰 New offer: ₦${price}`);
      }

      delete priceState[userId];

      bot.sendMessage(userId, "✅ Offer submitted!");

      return bot.answerCallbackQuery(query.id);
    }

    // ================= SELECT OFFER =================
    if (data.startsWith("select_")) {

      const parts = data.split("_");

      const taskId = parts[1];
      const runnerId = parts[2];
      const price = parseInt(parts[3]);

      const helplyFee = 200;
      const total = price + helplyFee;

      await supabase.from("orders").update({
        status: "selected",
        runner_id: runnerId,
        agreed_price: price
      }).eq("id", taskId);

      bot.sendMessage(
        userId,
        `🧾 Order Summary\n\nRunner: ₦${price}\nFee: ₦${helplyFee}\n\nTotal: ₦${total}`
      );

      return bot.answerCallbackQuery(query.id);
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});


// ================= VIEW OFFERS =================
bot.onText(/\/offers (.+)/, async (msg, match) => {

  const taskId = match[1];
  const userId = msg.chat.id;

  const { data: offers } = await supabase
    .from("offers")
    .select("*")
    .eq("order_id", taskId);

  if (!offers || offers.length === 0) {
    return bot.sendMessage(userId, "No offers yet.");
  }

  const buttons = offers.map(o => [
    {
      text: `${o.runner_name} — ₦${o.price}`,
      callback_data: `select_${taskId}_${o.runner_id}_${o.price}`
    }
  ]);

  bot.sendMessage(userId, "💰 Choose an offer:", {
    reply_markup: { inline_keyboard: buttons }
  });
});


// ================= ERROR =================
bot.on("polling_error", (err) => {
  console.log("Polling Error:", err.message);
});