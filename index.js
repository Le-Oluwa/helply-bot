require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

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

  // 🔥 GLOBAL DEBUG LOG
  console.log("📩 CALLBACK RECEIVED:", data);

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

      const sent = await bot.sendMessage(userId, `💰 Set your price: ₦500`, {
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

      // update text
      await bot.editMessageText(
        `💰 Set your price: ₦${priceState[userId].price}`,
        {
          chat_id: userId,
          message_id: priceState[userId].messageId
        }
      );

      // update buttons
      await bot.editMessageReplyMarkup(
        {
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
        },
        {
          chat_id: userId,
          message_id: priceState[userId].messageId
        }
      );

      return;
    }


    // ================= SUBMIT OFFER (DEBUG VERSION) =================
    if (data.startsWith("submit_")) {
      await bot.answerCallbackQuery(query.id);

      console.log("🔥 SUBMIT BLOCK HIT");

      const taskId = data.split("_")[1];

      console.log("TASK ID:", taskId);
      console.log("STATE:", priceState[userId]);

      return bot.sendMessage(userId, "✅ Submit button is working!");
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});