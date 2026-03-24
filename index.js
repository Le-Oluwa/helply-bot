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

  console.log("📩 CALLBACK:", data);

  try {

    // ================= MAKE OFFER =================
    if (data.startsWith("offer_")) {
      await bot.answerCallbackQuery(query.id);

      const taskId = data.split("_")[1];

      if (!priceState[userId]) priceState[userId] = {};

      priceState[userId][taskId] = { price: 500 };

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

      if (!priceState[userId] || !priceState[userId][taskId]) return;

      if (data.startsWith("plus_")) priceState[userId][taskId].price += 100;
      if (data.startsWith("minus_")) priceState[userId][taskId].price -= 100;
      if (data.startsWith("plus500_")) priceState[userId][taskId].price += 500;
      if (data.startsWith("minus500_")) priceState[userId][taskId].price -= 500;

      priceState[userId][taskId].price = Math.max(100, priceState[userId][taskId].price);

      bot.sendMessage(
        userId,
        `💰 Updated price: ₦${priceState[userId][taskId].price}`,
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

      return;
    }


    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {
      await bot.answerCallbackQuery(query.id);

      const taskId = data.split("_")[1];

      if (!priceState[userId] || !priceState[userId][taskId]) {
        return bot.sendMessage(userId, "⚠️ Session expired.");
      }

      const price = priceState[userId][taskId].price;

      const { error } = await supabase.from("offers").insert([{
        order_id: taskId,
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price
      }]);

      if (error) {
        console.log("❌ INSERT ERROR:", error);
        return bot.sendMessage(userId, "❌ Failed to submit offer.");
      }

      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId);

      if (!orders || orders.length === 0) return;

      const order = orders[0];

      await bot.sendMessage(
        Number(order.user_id),
        "💰 New offer received!",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "👀 View Offers", callback_data: `view_${taskId}` }]
            ]
          }
        }
      );

      delete priceState[userId][taskId];

      bot.sendMessage(userId, "✅ Offer submitted!");

      return;
    }


    // ================= VIEW OFFERS =================
    if (data.startsWith("view_")) {
      await bot.answerCallbackQuery(query.id);

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

      bot.sendMessage(userId, `💰 Available Offers (${offers.length})`, {
        reply_markup: { inline_keyboard: buttons }
      });

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
    console.log("ERROR:", err.message);
  }
});