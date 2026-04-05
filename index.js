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

const negotiationState = {};

console.log("🚀 Helply Running");


// ================= CREATE ORDER =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text;

  // ================= NEGOTIATION INPUT =================
  if (negotiationState[userId]) {
    const price = Number(text);
    const { offerId, role } = negotiationState[userId];

    const { data: offer } = await supabase
      .from("offers")
      .select("*")
      .eq("id", offerId)
      .maybeSingle();

    if (!offer) return;

    // update DB
    await supabase
      .from("offers")
      .update({
        current_price: price,
        last_actor: role
      })
      .eq("id", offerId);

    // ================= USER COUNTER =================
    if (role === "user") {
      await bot.sendMessage(
        offer.runner_id,
        `💬 Customer countered: ₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `accept_${offerId}` }],
              [{ text: "💬 Counter", callback_data: `counter_runner_${offerId}` }],
              [{ text: "❌ Reject", callback_data: `reject_${offerId}` }]
            ]
          }
        }
      );
    }

    // ================= RUNNER COUNTER =================
    if (role === "runner") {
      await bot.sendMessage(
        offer.user_id,
        `💬 Runner countered: ₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `accept_${offerId}` }],
              [{ text: "💬 Counter", callback_data: `counter_user_${offerId}` }],
              [{ text: "❌ Reject", callback_data: `reject_${offerId}` }]
            ]
          }
        }
      );
    }

    delete negotiationState[userId];
    return;
  }


  // ================= CREATE ORDER =================
  if (msg.chat.type === "private") {

    const taskId = Date.now();

    await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId.toString(),
      delivery_location: text,
      status: "open",
      created_at: new Date()
    }]);

    bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW TASK\n🆔 ${taskId}\n📌 ${text}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Offer", callback_data: `offer_${taskId}_500` }]
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

    // ================= START OFFER =================
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");

      await bot.sendMessage(userId, `💰 Price: ₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕100", callback_data: `price_${taskId}_${+price+100}` }],
            [{ text: "➖100", callback_data: `price_${taskId}_${Math.max(100, price-100)}` }],
            [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
          ]
        }
      });
    }

    // ================= UPDATE PRICE =================
    if (data.startsWith("price_")) {
      const [_, taskId, price] = data.split("_");

      await bot.sendMessage(userId, `💰 Price: ₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕100", callback_data: `price_${taskId}_${+price+100}` }],
            [{ text: "➖100", callback_data: `price_${taskId}_${Math.max(100, price-100)}` }],
            [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
          ]
        }
      });
    }

    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {
      const [_, taskId, price] = data.split("_");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(taskId))
        .maybeSingle();

      await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: String(taskId),
        user_id: order.user_id,
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price: Number(price),
        current_price: Number(price),
        last_actor: "runner",
        created_at: new Date()
      }]);

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId));

      const buttons = offers.map(o => [
        {
          text: `${o.runner_name} - ₦${o.current_price}`,
          callback_data: `view_${o.id}`
        }
      ]);

      await bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });

      return bot.sendMessage(userId, "✅ Offer sent");
    }

    // ================= VIEW OFFER =================
    if (data.startsWith("view_")) {
      const offerId = data.split("_")[1];

      const { data: offer } = await supabase
        .from("offers")
        .select("*")
        .eq("id", offerId)
        .maybeSingle();

      await bot.sendMessage(
        userId,
        `👤 ${offer.runner_name}\n💰 ₦${offer.current_price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `accept_${offerId}` }],
              [{ text: "💬 Counter", callback_data: `counter_user_${offerId}` }],
              [{ text: "❌ Reject", callback_data: `reject_${offerId}` }]
            ]
          }
        }
      );
    }

    // ================= USER COUNTER =================
    if (data.startsWith("counter_user_")) {
      const offerId = data.split("_")[2];

      negotiationState[userId] = { offerId, role: "user" };

      return bot.sendMessage(userId, "Enter your price:");
    }

    // ================= RUNNER COUNTER =================
    if (data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[2];

      negotiationState[userId] = { offerId, role: "runner" };

      return bot.sendMessage(userId, "Enter your price:");
    }

    // ================= ACCEPT =================
    if (data.startsWith("accept_")) {
      const offerId = data.split("_")[1];

      const { data: offer } = await supabase
        .from("offers")
        .select("*")
        .eq("id", offerId)
        .maybeSingle();

      const finalPrice = offer.current_price;

      await bot.sendMessage(
        userId,
        `✅ Deal accepted at ₦${finalPrice}`
      );

      await bot.sendMessage(
        offer.runner_id,
        `🎉 Your offer was accepted!\n💰 ₦${finalPrice}`
      );
    }

    // ================= REJECT =================
    if (data.startsWith("reject_")) {
      const offerId = data.split("_")[1];

      await bot.sendMessage(userId, "❌ Offer rejected");
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});