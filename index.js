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

console.log("🚀 Helply Running");


// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text.trim();

  if (text.startsWith("/")) return;

  if (msg.chat.type === "private") {

    const taskId = Date.now();

    const { error } = await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId.toString(),
      delivery_location: text,
      status: "negotiating",
      created_at: new Date()
    }]);

    if (error) {
      console.log("❌ ORDER ERROR:", error);
      return bot.sendMessage(userId, "❌ Failed to create request.");
    }

    console.log("✅ ORDER CREATED:", taskId);

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

  try {

    if (data.startsWith("offer_")) {
      await bot.answerCallbackQuery(query.id);

      const taskId = Number(data.split("_")[1]);

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


    if (
      data.startsWith("plus_") ||
      data.startsWith("minus_") ||
      data.startsWith("plus500_") ||
      data.startsWith("minus500_")
    ) {
      await bot.answerCallbackQuery(query.id);

      const taskId = Number(data.split("_")[1]);

      if (!priceState[userId]) return;

      if (data.startsWith("plus_")) priceState[userId].price += 100;
      if (data.startsWith("minus_")) priceState[userId].price -= 100;
      if (data.startsWith("plus500_")) priceState[userId].price += 500;
      if (data.startsWith("minus500_")) priceState[userId].price -= 500;

      priceState[userId].price = Math.max(100, priceState[userId].price);

      await bot.editMessageText(
        `💰 Set your price: ₦${priceState[userId].price}`,
        {
          chat_id: userId,
          message_id: priceState[userId].messageId,
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

      return;
    }


    if (data.startsWith("submit_")) {
      await bot.answerCallbackQuery(query.id);

      const taskId = Number(data.split("_")[1]);

      if (!priceState[userId]) {
        return bot.sendMessage(userId, "⚠️ No active offer.");
      }

      const { price } = priceState[userId];

      const { error } = await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: String(taskId), // ✅ FIXED
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price
      }]);

      if (error) {
        console.log("❌ OFFER ERROR:", error);
        return bot.sendMessage(userId, "❌ Failed to save offer.");
      }

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId)
        .maybeSingle();

      if (!order) return;

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId)); // ✅ FIXED

      if (offers && offers.length > 0) {
        offers.sort((a, b) => a.price - b.price);

        const text = offers
          .map(o => `👤 ${o.runner_name} — ₦${o.price}`)
          .join("\n");

        await bot.sendMessage(
          parseInt(order.user_id),
          `💰 Available Offers:\n\n${text}`
        );
      }

      delete priceState[userId];

      return bot.sendMessage(userId, "✅ Offer submitted!");
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});