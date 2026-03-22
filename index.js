require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

const userState = {};

console.log("🚀 Helply Negotiation Bot Running");


// ================= START =================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Welcome to Helply\n\nSend what you need."
  );
});


// ================= MAIN MESSAGE HANDLER =================
bot.on("message", async (msg) => {

  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;

  const userId = msg.chat.id;

  try {

    // ================= RUNNER MAKING OFFER =================
    if (userState[userId]?.makingOffer) {

      const price = parseInt(msg.text);
      const taskId = userState[userId].taskId;

      if (isNaN(price)) {
        return bot.sendMessage(userId, "Enter a valid price.");
      }

      await supabase.from("offers").insert([{
        order_id: taskId,
        runner_id: userId.toString(),
        runner_name: msg.from.first_name,
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

      delete userState[userId];
      return;
    }

    // ================= NEGOTIATION CHAT =================
    if (userState[userId]?.replying) {

      const { taskId, role } = userState[userId];
      const text = msg.text;

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId)
        .single();

      if (!order) return;

      if (role === "runner") {

        bot.sendMessage(
          order.user_id,
          `💬 Runner says:\n${text}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Reply", callback_data: `reply_user_${taskId}` }]
              ]
            }
          }
        );

      } else {

        const { data: offers } = await supabase
          .from("offers")
          .select("*")
          .eq("order_id", taskId);

        if (offers && offers.length > 0) {
          offers.forEach(o => {
            bot.sendMessage(
              o.runner_id,
              `💬 User says:\n${text}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "Reply", callback_data: `reply_runner_${taskId}` }]
                  ]
                }
              }
            );
          });
        }
      }

      delete userState[userId];
      return;
    }

    // ================= USER CREATES TASK =================
    if (msg.chat.type !== "private") return;

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
      `🚨 NEW REQUEST

🆔 ${taskId}
📌 ${taskText}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Make Offer", callback_data: `offer_${taskId}` }],
            [{ text: "💬 Ask Question", callback_data: `reply_runner_${taskId}` }]
          ]
        }
      }
    );

  } catch (err) {
    console.log("ERROR:", err.message);
  }

});


// ================= CALLBACK HANDLER =================
bot.on("callback_query", async (query) => {

  const data = query.data;
  const userId = query.from.id;

  try {

    // ================= MAKE OFFER =================
    if (data.startsWith("offer_")) {

      const taskId = data.split("_")[1];

      userState[userId] = {
        taskId,
        makingOffer: true
      };

      bot.sendMessage(userId, "💰 Enter your price:");

      return bot.answerCallbackQuery(query.id);
    }

    // ================= RUNNER REPLY =================
    if (data.startsWith("reply_runner_")) {

      const taskId = data.split("_")[2];

      userState[userId] = {
        replying: true,
        taskId,
        role: "runner"
      };

      bot.sendMessage(userId, "💬 Type message:");

      return bot.answerCallbackQuery(query.id);
    }

    // ================= USER REPLY =================
    if (data.startsWith("reply_user_")) {

      const taskId = data.split("_")[2];

      userState[userId] = {
        replying: true,
        taskId,
        role: "user"
      };

      bot.sendMessage(userId, "💬 Reply:");

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
        `🧾 Order Summary

Runner: ₦${price}
Fee: ₦${helplyFee}

Total: ₦${total}`
      );

      return bot.answerCallbackQuery(query.id);
    }

  } catch (err) {
    console.log("CALLBACK ERROR:", err.message);
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