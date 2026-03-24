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

console.log("🚀 Bot running");


// ================= NEW REQUEST =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text.trim();

  // 🔥 HANDLE PRICE INPUT
  if (priceState[userId]) {
    const price = Number(text);

    if (!price || price < 100) {
      return bot.sendMessage(userId, "❌ Enter a number like 500");
    }

    const taskId = priceState[userId].taskId;

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

    delete priceState[userId];

    return bot.sendMessage(userId, "✅ Offer submitted!");
  }

  // ignore commands
  if (text.startsWith("/")) return;

  // 🔥 CREATE REQUEST
  if (msg.chat.type === "private") {

    const taskId = Math.random().toString(36).substring(2, 9);

    const { error } = await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId.toString(),
      task: text
    }]);

    if (error) {
      console.log("❌ ORDER ERROR:", error);
      return;
    }

    bot.sendMessage(userId, "✅ Request sent");

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW TASK\n\n🆔 ${taskId}\n📌 ${text}`,
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


// ================= BUTTON =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;

  if (data.startsWith("offer_")) {
    const taskId = data.split("_")[1];

    priceState[userId] = { taskId };

    bot.sendMessage(userId, "💰 Send your price (e.g. 500)");
  }
});