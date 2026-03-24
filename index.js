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

const priceState = {};
const offerMessages = {};

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
      await bot.answerCallbackQuery(query.id);

      const taskId = data.split("_")[1];

      priceState[userId] = {
        taskId,
        price: 500,
        messageId: null
      };

      const sent = await bot.sendMessage(
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

      priceState[userId].messageId = sent.message_id;
      return;
    }


    // ================= PRICE CONTROL =================
    if (
      data.startsWith("plus_") ||
      data.startsWith("minus_") ||
      data.startsWith("plus500_") ||
      data.startsWith("minus500_")
    ) {
      await bot.answerCallbackQuery(query.id);

      const taskId = data.split("_")[1];

      if (!priceState[userId] || priceState[userId].taskId !== taskId) return;

      if (data.startsWith("plus_")) priceState[userId].price += 100;
      if (data.startsWith("minus_")) priceState[userId].price -= 100;
      if (data.startsWith("plus500_")) priceState[userId].price += 500;
      if (data.startsWith("minus500_")) priceState[userId].price -= 500;

      priceState[userId].price = Math.max(100, priceState[userId].price);

      // 🔥 DELETE OLD MESSAGE (KEY FIX)
      try {
        await bot.deleteMessage(userId, query.message.message_id);
      } catch (e) {}

      // 🔥 SEND NEW MESSAGE
      const sent = await bot.sendMessage(
        userId,
        `💰 Set your price: ₦${priceState[userId].price}`,
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

      priceState[userId].messageId = sent.message_id;

      return;
    }


    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {
      await bot.answerCallbackQuery(query.id);

      const taskId = data.split("_")[1];

      if (!priceState[userId] || priceState[userId].taskId !== taskId) {
        return bot.sendMessage(userId, "⚠️ Session expired.");
      }

      const price = priceState[userId].price;

      const { error } = await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: taskId,
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price
      }]);

      if (error) {
        console.log("❌ SUPABASE ERROR:", error);
        return bot.sendMessage(userId, "❌ Failed to save offer.");
      }

      bot.sendMessage(userId, "✅ Offer submitted!");
      delete priceState[userId];

      return;
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});


// 🔥 GLOBAL ERROR HANDLER
process.on("unhandledRejection", (err) => console.log("UNHANDLED:", err));
process.on("uncaughtException", (err) => console.log("UNCAUGHT:", err));