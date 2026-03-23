require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

const priceState = {};

console.log("🚀 Helply Bot Running (Offers + Payment)");


// ================= PAYSTACK =================
async function createPayment(email, amount, taskId) {
  const res = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email,
      amount: amount * 100,
      metadata: { taskId }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.data;
}


// ================= START =================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Welcome to Helply 🚀\n\nSend what you need.");
});


// ================= USER REQUEST =================
bot.on("message", async (msg) => {

  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.chat.id;
  const taskText = msg.text;

  const taskId = Math.random().toString(36).substring(2, 9);

  console.log("✅ CREATED ORDER ID:", taskId);

  const { data, error } = await supabase.from("orders").insert([{
  id: taskId,
  user_id: userId.toString(),
  task: taskText,
  status: "negotiating",
  created_at: new Date()
}]).select();

console.log("ORDER INSERT DATA:", data);
console.log("ORDER INSERT ERROR:", error);

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

    // ================= MAKE OFFER =================
    if (data.startsWith("offer_")) {

      const taskId = data.split("_")[1];

      priceState[userId] = {
        taskId,
        price: 500
      };

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
    if (priceState[userId]) {

      if (data.startsWith("plus_")) priceState[userId].price += 100;
      if (data.startsWith("minus_")) priceState[userId].price = Math.max(100, priceState[userId].price - 100);
      if (data.startsWith("plus500_")) priceState[userId].price += 500;
      if (data.startsWith("minus500_")) priceState[userId].price = Math.max(100, priceState[userId].price - 500);

      if (
        data.startsWith("plus_") ||
        data.startsWith("minus_") ||
        data.startsWith("plus500_") ||
        data.startsWith("minus500_")
      ) {
        const current = priceState[userId].price;

        bot.editMessageText(`💰 Set your price: ₦${current}`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: query.message.reply_markup
        });

        return bot.answerCallbackQuery(query.id);
      }
    }

    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {

      const taskIdRaw = data.split("_")[1];
      const taskId = taskIdRaw.trim();

      if (!priceState[userId]) {
        console.log("❌ No price state for user:", userId);
        return bot.sendMessage(userId, "⚠️ Session expired. Click 'Make Offer' again.");
      }

      const price = priceState[userId].price;

      console.log("📌 SUBMITTING OFFER:", { taskId, userId, price });

      const { data: inserted, error } = await supabase
        .from("offers")
        .insert([{
          order_id: taskId,
          runner_id: userId.toString(),
          runner_name: query.from.first_name,
          price
        }])
        .select();

      console.log("INSERTED OFFER:", inserted);
      console.log("INSERT ERROR:", error);

      if (error) {
        return bot.sendMessage(userId, "❌ Failed to submit offer.");
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId)
        .maybeSingle();

      console.log("FETCHED ORDER:", order);
      console.log("ORDER ERROR:", orderError);

      if (!order) {
        const { data: allOrders } = await supabase
          .from("orders")
          .select("*");

        console.log("ALL ORDERS IN DB:", allOrders);

        return bot.sendMessage(userId, "❌ Order not found.");
      }

      await bot.sendMessage(
        order.user_id,
        `💰 New offer received: ₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "👀 View Offers", callback_data: `view_${taskId}` }]
            ]
          }
        }
      );

      delete priceState[userId];

      bot.sendMessage(userId, "✅ Offer submitted!");

      return bot.answerCallbackQuery(query.id);
    }

    // ================= VIEW OFFERS =================
    if (data.startsWith("view_")) {
      const taskId = data.split("_")[1].trim();

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", taskId);

      console.log("VIEW TASK:", taskId);
      console.log("OFFERS:", offers);

      if (!offers || offers.length === 0) {
        return bot.sendMessage(userId, "No offers yet.");
      }

      offers.sort((a, b) => a.price - b.price);

      const buttons = offers.map(o => [
        {
          text: `${o.runner_name} — ₦${o.price}`,
          callback_data: `select_${taskId}_${o.id}_${o.price}`
        }
      ]);

      bot.sendMessage(userId, "💰 Available Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });

      return bot.answerCallbackQuery(query.id);
    }

    // ================= SELECT OFFER =================
    if (data.startsWith("select_")) {

      const parts = data.split("_");

      const taskId = parts[1];
      const offerId = parts[2];
      const price = parseInt(parts[3]);

      const helplyFee = 200;
      const total = price + helplyFee;

      const { data: offer } = await supabase
        .from("offers")
        .select("*")
        .eq("id", offerId)
        .maybeSingle();

      if (!offer) {
        return bot.sendMessage(userId, "❌ Offer not found.");
      }

      await supabase.from("orders").update({
        status: "awaiting_payment",
        runner_id: offer.runner_id,
        agreed_price: price
      }).eq("id", taskId);

      const payment = await createPayment(
        `${userId}@helply.com`,
        total,
        taskId
      );

      bot.sendMessage(userId, `🧾 *Payment Required*

Runner Price: ₦${price}
Helply Fee: ₦${helplyFee}

💰 Total: ₦${total}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Pay Now", url: payment.authorization_url }]
          ]
        }
      });

      bot.sendMessage(userId, "After payment, click below:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ I Have Paid", callback_data: `verify_${taskId}` }]
          ]
        }
      });

      return bot.answerCallbackQuery(query.id);
    }

    // ================= VERIFY PAYMENT =================
    if (data.startsWith("verify_")) {

      const taskId = data.split("_")[1];

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId)
        .maybeSingle();

      await supabase.from("orders").update({
        payment_status: "paid",
        status: "in_progress"
      }).eq("id", taskId);

      bot.sendMessage(order.user_id, "✅ Payment confirmed!");
      bot.sendMessage(order.runner_id, "🎉 Payment received!");

      return bot.answerCallbackQuery(query.id);
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});

bot.on("polling_error", (err) => {
  console.log("Polling Error:", err.message);
});