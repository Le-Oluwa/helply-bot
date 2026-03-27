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
      status: "open",
      created_at: new Date()
    }]);

    if (error) {
      console.log("❌ ORDER ERROR:", error);
      return bot.sendMessage(userId, "❌ Failed to create request.");
    }

    bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW REQUEST\n\n🆔 ${taskId}\n📌 ${text}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Make Offer", callback_data: `offer_${taskId}_500` }]
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
      await bot.answerCallbackQuery(query.id);

      const parts = data.split("_");
      const taskId = Number(parts[1]);
      const price = Number(parts[2]);

      await bot.sendMessage(userId, `💰 Set your price: ₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➖100", callback_data: `price_${taskId}_${price - 100}` },
              { text: "➕100", callback_data: `price_${taskId}_${price + 100}` }
            ],
            [
              { text: "➖500", callback_data: `price_${taskId}_${price - 500}` },
              { text: "➕500", callback_data: `price_${taskId}_${price + 500}` }
            ],
            [
              { text: "✅ Submit Offer", callback_data: `submit_${taskId}_${price}` }
            ]
          ]
        }
      });

      return;
    }


    // ================= UPDATE PRICE =================
    if (data.startsWith("price_")) {
      await bot.answerCallbackQuery(query.id);

      const parts = data.split("_");
      const taskId = Number(parts[1]);
      let price = Number(parts[2]);

      price = Math.max(100, price);

      await bot.sendMessage(userId, `💰 Set your price: ₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➖100", callback_data: `price_${taskId}_${price - 100}` },
              { text: "➕100", callback_data: `price_${taskId}_${price + 100}` }
            ],
            [
              { text: "➖500", callback_data: `price_${taskId}_${price - 500}` },
              { text: "➕500", callback_data: `price_${taskId}_${price + 500}` }
            ],
            [
              { text: "✅ Submit Offer", callback_data: `submit_${taskId}_${price}` }
            ]
          ]
        }
      });

      return;
    }


    // ================= SUBMIT OFFER =================
    if (data.startsWith("submit_")) {
      await bot.answerCallbackQuery(query.id);

      const parts = data.split("_");
      const taskId = Number(parts[1]);
      const price = Number(parts[2]);

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", taskId)
        .maybeSingle();

      if (!order) {
        return bot.sendMessage(userId, "❌ Order not found.");
      }

      // 🚫 prevent self bidding
      if (order.user_id === userId.toString()) {
        return bot.sendMessage(userId, "❌ You cannot bid on your own request.");
      }

      const { error } = await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: String(taskId),
        runner_id: userId.toString(),
        runner_name: query.from.first_name,
        price,
        created_at: new Date()
      }]);

      if (error) {
        console.log("❌ OFFER ERROR:", error);
        return bot.sendMessage(userId, "❌ Failed to save offer.");
      }

      // 🔥 fetch offers
      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId));

      if (offers && offers.length > 0) {
        offers.sort((a, b) => a.price - b.price);

        const buttons = offers.map(o => [
          {
            text: `👤 ${o.runner_name} — ₦${o.price}`,
            callback_data: `select_${taskId}_${o.id}_${o.price}_${o.runner_id}`
          }
        ]);

        await bot.sendMessage(
          parseInt(order.user_id),
          "💰 Choose an offer:",
          { reply_markup: { inline_keyboard: buttons } }
        );
      }

      return bot.sendMessage(userId, "✅ Offer submitted!");
    }


    // ================= SELECT OFFER =================
    if (data.startsWith("select_")) {
      await bot.answerCallbackQuery(query.id);

      const parts = data.split("_");

      const taskId = Number(parts[1]);
      const offerId = parts[2];
      const price = Number(parts[3]);
      const runnerId = parts[4];

      await supabase.from("orders").update({
        status: "assigned",
        agreed_price: price,
        assigned_runner_id: runnerId
      }).eq("id", taskId);

      await supabase
        .from("offers")
        .delete()
        .eq("order_id", String(taskId))
        .neq("id", offerId);

      await bot.sendMessage(userId, `✅ Offer selected!\n💵 ₦${price}`);

      return;
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});