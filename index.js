// ================= REQUIRE =================
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const express = require("express");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;
const BASE_URL = process.env.BASE_URL;

// ================= HELPER =================
async function isBusy(userId) {
  const { data } = await supabase
    .from("orders")
    .select("id, status")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .in("status", ["matched", "in_progress"]);

  return data && data.length > 0;
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();
  const username = msg.from.username || "";

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user) {
    await supabase.from("users").insert([{
      id: userId,
      username,
      accepted_terms: false
    }]);
  }

  if (!user || !user.accepted_terms) {
    return bot.sendMessage(userId,
`👋 Welcome to Helply

Please accept terms`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Accept Terms", callback_data: "accept_terms" }
        ]]
      }
    });
  }

  return bot.sendMessage(userId, `🚀 Send your request`);
});

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = msg.from.id.toString();
  const text = msg.text;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user) return bot.sendMessage(userId, "Use /start");
  if (!user.accepted_terms) return bot.sendMessage(userId, "Accept terms first");

  // ACTIVE CHAT
  const { data: active } = await supabase
    .from("orders")
    .select("*")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .eq("status", "in_progress")
    .maybeSingle();

  if (active) {
    const receiver =
      userId === active.user_id ? active.runner_id : active.user_id;
    return bot.sendMessage(receiver, `💬 ${msg.from.first_name}: ${text}`);
  }

  // CLEANUP
  await supabase.from("orders")
    .update({ status: "completed" })
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .in("status", ["matched", "in_progress"]);

  if (await isBusy(userId)) {
    return bot.sendMessage(userId, "❌ Finish current task first");
  }

  const taskId = Date.now();

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId,
    user_username: msg.from.username || "",
    delivery_location: text,
    status: "open",
    payment_status: "pending"
  }]);

  await bot.sendMessage(userId, `✅ Request sent`);

  try {
    await bot.sendMessage(
      RUNNER_GROUP_ID,
`🚨 NEW REQUEST

🆔 ${taskId}
📌 ${text}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Offer", callback_data: `offer_${taskId}_500` }]
          ]
        }
      }
    );
  } catch (err) {
    console.log("GROUP ERROR:", err.message);
  }
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {

    // ACCEPT TERMS
    if (data === "accept_terms") {
      await supabase.from("users")
        .update({ accepted_terms: true })
        .eq("id", userId);

      await bot.sendMessage(userId, "🎉 You're in! Send your request");
      return bot.answerCallbackQuery(q.id);
    }

    // OFFER
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");

      // CLEAN runner
      await supabase.from("orders")
        .update({ status: "completed" })
        .eq("runner_id", userId)
        .in("status", ["matched", "in_progress"]);

      if (await isBusy(userId)) {
        return bot.answerCallbackQuery(q.id, {
          text: "❌ Finish current task first",
          show_alert: true
        });
      }

      await bot.sendMessage(userId,
`💰 Set your offer ₦${price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "+100", callback_data: `adj_${taskId}_${price}_100` }],
            [{ text: "-100", callback_data: `adj_${taskId}_${price}_-100` }],
            [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
          ]
        }
      });

      return bot.answerCallbackQuery(q.id);
    }

    // SUBMIT OFFER
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
        runner_id: userId,
        runner_name: q.from.first_name,
        runner_username: q.from.username || "",
        current_price: Number(price)
      }]);

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId));

      const buttons = offers.map(o => [
        { text: `${o.runner_name} - ₦${o.current_price}`, callback_data: `view_${o.id}` }
      ]);

      await bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });

      return bot.answerCallbackQuery(q.id);
    }

    // VIEW OFFER
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      await bot.sendMessage(userId,
`${o.runner_name} - ₦${o.current_price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept", callback_data: `accept_${id}` }]
          ]
        }
      });

      return bot.answerCallbackQuery(q.id);
    }

    // ACCEPT OFFER
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      const runnerFee = Number(o.current_price);
      const runnerPayout = Math.round(runnerFee * 0.9);
      const userPrice = Math.round(runnerFee * 1.3);

      await supabase.from("orders").update({
        runner_id: o.runner_id,
        runner_username: o.runner_username,
        agreed_price: runnerFee,
        runner_payout: runnerPayout,
        total_price: userPrice,
        status: "matched"
      }).eq("id", Number(o.order_id));

      await supabase.from("offers")
        .delete()
        .eq("order_id", String(o.order_id));

      const link = `${BASE_URL}/create-payment?orderId=${o.order_id}`;

      await bot.sendMessage(o.runner_id,
`📦 Task assigned

💰 You earn ₦${runnerPayout}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel Task", callback_data: `cancel_${o.order_id}` }]
          ]
        }
      });

      await bot.sendMessage(o.user_id,
`💳 Pay ₦${userPrice}

${link}`);

      return bot.answerCallbackQuery(q.id);
    }

    // CANCEL
    if (data.startsWith("cancel_")) {
      const id = data.split("_")[1];

      await supabase.from("orders").update({
        runner_id: null,
        status: "open"
      }).eq("id", Number(id));

      return bot.answerCallbackQuery(q.id);
    }

    // END
    if (data.startsWith("end_")) {
      const id = data.split("_")[1];

      await supabase.from("orders")
        .update({ status: "completed" })
        .eq("id", Number(id));

      return bot.answerCallbackQuery(q.id);
    }

  } catch (err) {
    console.log("ERROR:", err.message);
  }
});

// ================= SERVER =================
app.listen(3000, () => {
  console.log("🌐 Server running on port 3000");
});
