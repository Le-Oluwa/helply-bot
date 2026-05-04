require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;
const BASE_URL = process.env.BASE_URL;

console.log("🚀 Helply Running");

// ================= HELPER =================
async function isBusy(userId) {
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .in("status", ["matched", "in_progress"]); // ✅ FIXED

  if (error) {
    console.log("BUSY ERROR:", error.message);
    return false;
  }

  return data.length > 0;
}

// ================= PAYMENT SUCCESS =================
app.post("/payment-success", async (req, res) => {
  try {
    const { orderId } = req.body;

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", Number(orderId))
      .maybeSingle();

    if (!order) return res.sendStatus(404);

    await supabase.from("orders").update({
      payment_status: "paid",
      status: "in_progress"
    }).eq("id", Number(orderId));

    const runnerTag = order.runner_username ? "@" + order.runner_username : "Runner";
    const userTag = order.user_username ? "@" + order.user_username : "User";

    await bot.sendMessage(order.user_id,
`✅ Payment confirmed!

🤝 You are now chatting with ${runnerTag}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ End Chat", callback_data: `end_${order.id}` }]
        ]
      }
    });

    if (order.runner_id) {
      await bot.sendMessage(order.runner_id,
`💰 Payment received!

🤝 You are now chatting with ${userTag}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: `cancel_${order.id}` }],
            [{ text: "❌ End Chat", callback_data: `end_${order.id}` }]
          ]
        }
      });
    }

    res.send("OK");

  } catch (err) {
    console.log("PAYMENT ERROR:", err);
    res.sendStatus(500);
  }
});

// ================= CREATE PAYMENT =================
app.get("/create-payment", async (req, res) => {
  try {
   const orderId = req.body.orderId || req.query.orderId;

    // ✅ Validate orderId
    if (!orderId) {
      return res.send("❌ Missing order ID");
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("id", Number(orderId))
      .maybeSingle();

    if (error) {
      console.log("FETCH ERROR:", error.message);
      return res.send("❌ Error fetching order");
    }

    // ✅ Validate order
    if (!order || !order.total_price) {
      return res.send("❌ Invalid order amount. Recreate order.");
    }

    // ✅ Prevent double payment
    if (order.payment_status === "paid") {
      return res.send("✅ This order is already paid.");
    }

    if (order.status === "in_progress") {
      return res.send("⚠️ Order already in progress.");
    }

    const amount = order.total_price * 100; // (for real payment later)

    // ✅ Clean payment UI
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px">
        <h2>💳 Payment</h2>
        <p><strong>Task Price:</strong> ₦${order.agreed_price || 0}</p>
        <p><strong>Service Fee:</strong> ₦${(order.total_price - order.agreed_price) || 0}</p>
        <h3>Total: ₦${order.total_price}</h3>

        <br/>

        <a href="${BASE_URL}/payment-success?orderId=${order.id}">
          <button style="padding:10px 20px;font-size:16px;">
            Pay Now
          </button>
        </a>
      </div>
    `);

  } catch (err) {
    console.log("PAYMENT PAGE ERROR:", err.message);
    return res.send("❌ Something went wrong");
  }
});
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

    return bot.sendMessage(userId,
`👋 Welcome to Helply!

Please accept Terms`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: "accept_terms" }]
        ]
      }
    });
  }

  if (!user.accepted_terms) {
    return bot.sendMessage(userId,
`Please accept Terms`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: "accept_terms" }]
        ]
      }
    });
  }

  bot.sendMessage(userId, "🚀 Send your request");
});

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text || /^\/\w+/.test(msg.text)) return;

  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user) return bot.sendMessage(userId, "⚠️ Please press /start first");
  if (!user.accepted_terms) return bot.sendMessage(userId, "⚠️ Please accept terms using /start");

  // ACTIVE CHAT
  const { data: activeOrder } = await supabase
    .from("orders")
    .select("*")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .eq("status", "in_progress")
    .maybeSingle();

  if (activeOrder) {
    const receiver =
      userId === activeOrder.user_id
        ? activeOrder.runner_id
        : activeOrder.user_id;

    return bot.sendMessage(receiver, `💬 ${msg.from.first_name}: ${text}`);
  }

  // ✅ CLEANUP FIRST (USER + RUNNER)
  await supabase.from("orders")
    .update({ status: "completed" })
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .in("status", ["matched", "in_progress"]);

  // BUSY CHECK
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

  await bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

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

}); // ✅ FIXED (message handler properly closed)

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {

    if (data === "accept_terms") {
      await supabase.from("users")
        .update({ accepted_terms: true })
        .eq("id", userId);

      await bot.sendMessage(userId, "🎉 You're in! Send your request now 🚀");
      return bot.answerCallbackQuery(q.id);
    }

    // ===== END =====
    if (data.startsWith("end_")) {
      const orderId = data.split("_")[1];

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(orderId))
        .maybeSingle();

      if (!order) return;

      const runnerId = order.runner_id;

      await supabase.from("orders").update({
        status: "completed",
        payment_status: "completed",
        runner_id: null
      }).eq("id", Number(orderId));

      await bot.sendMessage(order.user_id, "✅ Task completed.");

      if (runnerId) {
        await bot.sendMessage(runnerId, "✅ Task completed.");
      }

      return bot.answerCallbackQuery(q.id);
    }

    // ===== OFFER =====
    if (data.startsWith("offer_")) {
      const [_, taskId, price] = data.split("_");

      // ✅ CLEAN runner stale tasks
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
`💰 Set your offer

₦${price}`, {
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

    // ===== ADJUST =====
    if (data.startsWith("adj_")) {
      const [_, taskId, current, change] = data.split("_");

      let newPrice = Number(current) + Number(change);
      if (newPrice < 100) newPrice = 100;

      await bot.editMessageText(`₦${newPrice}`, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: "+100", callback_data: `adj_${taskId}_${newPrice}_100` }],
            [{ text: "-100", callback_data: `adj_${taskId}_${newPrice}_-100` }],
            [{ text: "Submit", callback_data: `submit_${taskId}_${newPrice}` }]
          ]
        }
      });

      return bot.answerCallbackQuery(q.id);
    }

    // ===== SUBMIT =====
    if (data.startsWith("submit_")) {
      const [_, taskId, price] = data.split("_");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(taskId))
        .maybeSingle();

      if (!order) return;

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
        { text: `${o.runner_name} — ₦${o.current_price}`, callback_data: `view_${o.id}` }
      ]);

      await bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });

      return bot.answerCallbackQuery(q.id);
    }

    // ===== VIEW =====
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (!o) {
        return bot.answerCallbackQuery(q.id, {
          text: "❌ Offer not found",
          show_alert: true
        });
      }

      await bot.sendMessage(userId,
`${o.runner_name} — ₦${o.current_price}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept", callback_data: `accept_${id}` }]
          ]
        }
      });

      return bot.answerCallbackQuery(q.id);
    }

    // ===== ACCEPT =====
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];
const { data: o, error } = await supabase
  .from("offers")
  .select("*")
  .eq("id", id)
  .maybeSingle();

if (error || !o) {
  console.log("OFFER FETCH ERROR:", error?.message);
  return bot.answerCallbackQuery(q.id, {
    text: "❌ Offer not found",
    show_alert: true
  });
}

// ✅ Validate price
const runnerFee = Number(o.current_price);
if (!runnerFee || runnerFee <= 0) {
  return bot.answerCallbackQuery(q.id, {
    text: "❌ Invalid price",
    show_alert: true
  });
}

// 🔥 PRICING LOGIC
const runnerPayout = Math.round(runnerFee * 0.9); // runner gets 90%
const userPrice = Math.round(runnerFee * 1.3);   // user pays +30%

// ✅ Delete other offers
await supabase.from("offers")
  .delete()
  .eq("order_id", String(o.order_id));

// ✅ Update order with FULL pricing
await supabase.from("orders").update({
  runner_id: o.runner_id,
  runner_username: o.runner_username,
  agreed_price: runnerFee,
  runner_payout: runnerPayout,
  total_price: userPrice,
  status: "matched"
}).eq("id", Number(o.order_id));

// ✅ Payment link
const link = `${BASE_URL}/create-payment?orderId=${o.order_id}`;

// ✅ Better message (VERY IMPORTANT)
await bot.sendMessage(o.user_id,
`💳 Payment Required

💰 Task Price: ₦${runnerFee}
📈 Service Fee: ₦${userPrice - runnerFee}
🧾 Total: ₦${userPrice}

👉 Pay here:
${link}`
);

return bot.answerCallbackQuery(q.id);
    }

    // ===== CANCEL =====
    if (data.startsWith("cancel_")) {
      const orderId = data.split("_")[1];

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(orderId))
        .maybeSingle();

      if (!order) return;

      await supabase.from("orders").update({
        runner_id: null,
        runner_username: null,
        status: "open",
        payment_status: "pending"
      }).eq("id", Number(orderId));

      await supabase.from("offers")
        .delete()
        .eq("order_id", orderId);

      await bot.sendMessage(order.user_id,
        "⚠️ Runner cancelled. New runners can offer.");

      if (order.runner_id) {
        await bot.sendMessage(order.runner_id,
          "❌ You cancelled the task.");
      }

      return bot.answerCallbackQuery(q.id);
    }

  } catch (err) {
    console.log("❌ ERROR:", err.message);
  }
});

// ================= SERVER =================
app.listen(3000, () => {
  console.log("🌐 Server running on port 3000");
});
