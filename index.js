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


// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.chat.id;
  const text = msg.text.trim().toLowerCase();

  console.log("📩 MESSAGE:", text);

  // ================= SUBMIT (FIXED) =================
  if (text === "submit") {

    console.log("🔥 SUBMIT RECEIVED");

    if (!priceState[userId]) {
      return bot.sendMessage(userId, "⚠️ No active offer.");
    }

    const { taskId, price } = priceState[userId];

    const { error } = await supabase.from("offers").insert([{
      id: uuidv4(),
      order_id: taskId,
      runner_id: userId.toString(),
      runner_name: msg.from.first_name,
      price
    }]);

    if (error) {
      console.log("❌ SUPABASE ERROR:", error);
      return bot.sendMessage(userId, "❌ Failed to save offer.");
    }

    console.log("✅ OFFER SAVED");

    // ===== SHOW OFFERS TO USER =====
    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", taskId)
      .single();

    const { data: offers } = await supabase
      .from("offers")
      .select("*")
      .eq("order_id", taskId);

    if (offers && offers.length > 0) {
      offers.sort((a, b) => a.price - b.price);

      const buttons = offers.map(o => [
        {
          text: `👤 ${o.runner_name} — ₦${o.price}`,
          callback_data: `select_${taskId}_${o.id}_${o.price}`
        }
      ]);

      const chatId = Number(order.user_id);

      if (!offerMessages[taskId]) {
        const sent = await bot.sendMessage(
          chatId,
          `💰 Available Offers (${offers.length})`,
          { reply_markup: { inline_keyboard: buttons } }
        );

        offerMessages[taskId] = sent.message_id;
      } else {
        await bot.editMessageText(
          `💰 Available Offers (${offers.length})`,
          {
            chat_id: chatId,
            message_id: offerMessages[taskId],
            reply_markup: { inline_keyboard: buttons }
          }
        );
      }
    }

    delete priceState[userId];

    return bot.sendMessage(userId, "✅ Offer submitted!");
  }

  // ================= IGNORE COMMANDS =================
  if (text.startsWith("/")) return;


  // ================= NEW REQUEST =================
  const taskId = Math.random().toString(36).substring(2, 9);

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId.toString(),
    task: msg.text,
    status: "negotiating",
    created_at: new Date()
  }]);

  bot.sendMessage(userId, `✅ Request sent\nTask ID: ${taskId}`);

  bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 NEW REQUEST\n\n🆔 ${taskId}\n📌 ${msg.text}`,
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
            ]
          ]
        }
      });

      priceState[userId].messageId = sent.message_id;

      bot.sendMessage(userId, "👉 Type 'submit' to send your offer");

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
              ]
            ]
          }
        }
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
    console.log("ERROR:", err.message);
  }
});