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
const pendingCounters = {};
const pendingRunnerCounters = {};

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

  // AUTO CREATE USER
  if (!user) {
    await supabase.from("users").insert([{
      id: userId,
      username,
      accepted_terms: false,
      banned: false
    }]);

    user = {
      id: userId,
      accepted_terms: false
    };
  }

  // TERMS FLOW
  if (!user.accepted_terms) {
    return bot.sendMessage(userId,
`📜 *Helply Terms & Conditions*

*Account Use*
• Provide accurate information
• Keep your account secure
• You are responsible for activities on your account

*Requesting Services*
• Helply connects users with independent Helpers
• Availability may vary
• Prices may change due to demand or waiting time

*Payments*
• Payments are processed through supported methods
• Refunds are reviewed case-by-case

*User Conduct*
• Treat Helpers respectfully
• No threats, harassment, or unsafe behavior
• Provide accurate locations

*Cancellation Policy*
• Cancellation fees may apply after a Helper starts moving

*Account Suspension*
Accounts may be suspended for:
• Fraud
• Abuse
• Fake identity information
• Safety violations

*Liability*
• Helply connects users with independent Helpers
• Helply is not directly responsible for Helper conduct

By continuing, you agree to these Terms & Conditions.`,
{
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✅ Accept", callback_data: "accept_terms" },
        { text: "❌ Decline", callback_data: "decline_terms" }
      ]
    ]
  }
});
  }

  // ALREADY ACCEPTED
  return bot.sendMessage(userId,
`🚀 Welcome back to Helply

Send your request`);
});
// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = msg.from.id.toString();   // ✅ REQUIRED
  const text = msg.text;                   // ✅ REQUIRED

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  console.log("USER CHECK:", {
    userId,
    exists: !!user
  });

  // 🔥 FIXED AUTO USER HANDLING
  let currentUser = user;

  if (!currentUser) {
    console.log("⚠️ Auto-creating user:", userId);

    const { error } = await supabase
      .from("users")
      .insert([{
        id: userId,
        username: msg.from.username || "",
        accepted_terms: true
      }]);

    if (error) {
      console.log("INSERT ERROR:", error.message);
      return bot.sendMessage(userId, "❌ Error creating account");
    }

    currentUser = {
      id: userId,
      accepted_terms: true
    };
  }

  // ✅ SAFE CHECK
  if (!currentUser.accepted_terms) {
    return bot.sendMessage(userId, "⚠️ Please accept terms using /start");
  }

  // ================= USER COUNTER =================
if (pendingCounters[userId]) {

  const offerId = pendingCounters[userId];
  const counterPrice = Number(text);

  if (isNaN(counterPrice) || counterPrice < 100) {
    return bot.sendMessage(userId, "❌ Invalid amount");
  }

  const { data: offer } = await supabase
    .from("offers")
    .update({
      current_price: counterPrice
    })
    .eq("id", offerId)
    .select()
    .maybeSingle();

  delete pendingCounters[userId];

  await bot.sendMessage(offer.runner_id,
`💬 User countered your offer

New price: ₦${counterPrice}`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: `accept_${offerId}` }
        ],
        [
          { text: "💬 Counter Again", callback_data: `counter_runner_${offerId}` }
        ]
      ]
    }
  });

  return;
}

// ================= RUNNER COUNTER =================
if (pendingRunnerCounters[userId]) {

  const offerId = pendingRunnerCounters[userId];
  const newPrice = Number(text);

  if (isNaN(newPrice) || newPrice < 100) {
    return bot.sendMessage(userId, "❌ Invalid amount");
  }

  const { data: offer } = await supabase
    .from("offers")
    .update({
      current_price: newPrice
    })
    .eq("id", offerId)
    .select()
    .maybeSingle();

  delete pendingRunnerCounters[userId];

  await bot.sendMessage(offer.user_id,
`💬 Runner updated the offer

New price: ₦${newPrice}`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: `accept_${offerId}` }
        ],
        [
          { text: "💬 Counter", callback_data: `counter_${offerId}` }
        ]
      ]
    }
  });

  return;
}
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

  // USER COUNTER
  if (data.startsWith("counter_")) {

    const offerId = data.split("_")[1];

    pendingCounters[userId] = offerId;

    await bot.sendMessage(userId,
      "💬 Enter your counter offer amount:");

    return bot.answerCallbackQuery(q.id);
  }

  // RUNNER COUNTER
  if (data.startsWith("counter_runner_")) {

    const offerId = data.split("_")[2];

    pendingRunnerCounters[userId] = offerId;

    await bot.sendMessage(userId,
      "💬 Enter your new offer amount:");

    return bot.answerCallbackQuery(q.id);
  }

  // ... your other handlers below
  
  // REJECT OFFER
if (data.startsWith("reject_")) {

  const offerId = data.split("_")[1];

  await supabase
    .from("offers")
    .delete()
    .eq("id", offerId);

  await bot.sendMessage(userId,
    "❌ Offer rejected");

  return bot.answerCallbackQuery(q.id);
}  
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

  if (!o) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Offer not found"
    });
  }

  await bot.sendMessage(
    userId,
`${o.runner_name} - ₦${o.current_price}`,
{
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✅ Accept", callback_data: `accept_${id}` }
      ],
      [
        { text: "💬 Counter", callback_data: `counter_${id}` }
      ],
      [
        { text: "❌ Reject", callback_data: `reject_${id}` }
      ]
    ]
  }
});

  return bot.answerCallbackQuery(q.id);
}
    // ACCEPT OFFER
   // ACCEPT OFFER
if (data.startsWith("accept_")) {

  const id = data.split("_")[1];

  const { data: o } = await supabase
    .from("offers")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!o) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Offer not found"
    });
  }

  const runnerFee = Number(o.current_price);
  const runnerPayout = Math.round(runnerFee * 0.9);
  const userPrice = Math.round(runnerFee * 1.3);

  await supabase.from("orders")
    .update({
      runner_id: o.runner_id,
      runner_username: o.runner_username,
      agreed_price: runnerFee,
      runner_payout: runnerPayout,
      total_price: userPrice,
      status: "matched",
      payment_status: "pending"
    })
    .eq("id", Number(o.order_id));

  // DELETE OTHER OFFERS
  await supabase.from("offers")
    .delete()
    .eq("order_id", String(o.order_id));

  const link =
`${BASE_URL}/create-payment?orderId=${o.order_id}`;

  // RUNNER MESSAGE
  await bot.sendMessage(
    o.runner_id,
`📦 Task assigned

⏳ Waiting for user payment...`,
{
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "❌ Cancel Task",
          callback_data: `cancel_${o.order_id}`
        }
      ]
    ]
  }
});

  // USER MESSAGE
  await bot.sendMessage(
    o.user_id,
`💳 Pay ₦${userPrice}

${link}`
  );

  return bot.answerCallbackQuery(q.id);
}
   
// CANCEL TASK
// CANCEL TASK
if (data.startsWith("cancel_")) {

  const id = data.split("_")[1];

  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("id", Number(id))
    .maybeSingle();

  if (!order) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Order not found"
    });
  }

  // BLOCK CANCEL AFTER PAYMENT
  if (order.payment_status === "paid") {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Cannot cancel after payment",
      show_alert: true
    });
  }

  // RESET ORDER
  await supabase.from("orders")
    .update({
      runner_id: null,
      runner_username: null,
      agreed_price: null,
      runner_payout: null,
      total_price: null,
      status: "open",
      payment_status: "pending"
    })
    .eq("id", Number(id));

  // DELETE OLD OFFERS
  await supabase.from("offers")
    .delete()
    .eq("order_id", String(id));

  // REPOST TO GROUP
  await bot.sendMessage(
    RUNNER_GROUP_ID,
`🚨 REPOSTED REQUEST

🆔 ${order.id}
📌 ${order.delivery_location}`,
{
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "💰 Offer",
          callback_data: `offer_${order.id}_500`
        }
      ]
    ]
  }
});

  // USER
  await bot.sendMessage(
    order.user_id,
`⚠️ Your Helper cancelled the task.

Your request has been reposted.`
  );

  // RUNNER
  await bot.sendMessage(
    order.runner_id,
`❌ Task cancelled`
  );

  return bot.answerCallbackQuery(q.id);
}

// END TASK
if (data.startsWith("end_")) {

  const id = data.split("_")[1];

  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("id", Number(id))
    .maybeSingle();

  if (!order) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Task not found"
    });
  }

  // ONLY ACTIVE TASKS
  if (order.status !== "in_progress") {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Task already ended"
    });
  }

  // END TASK
  await supabase.from("orders")
    .update({
      status: "completed"
    })
    .eq("id", Number(id));

  // USER
  await bot.sendMessage(
    order.user_id,
    "✅ Task ended successfully"
  );

  // RUNNER
  await bot.sendMessage(
    order.runner_id,
    "✅ Task completed successfully"
  );

  return bot.answerCallbackQuery(q.id, {
    text: "✅ Task ended"
  });
}

  } catch (err) {
    console.log("ERROR:", err.message);
  }

});

// ================= PAYMENT SUCCESS =================
app.all("/payment-success", async (req, res) => {

  console.log("🔥 PAYMENT SUCCESS HIT");

  try {

    const orderId = req.query.orderId;

    if (!orderId) {
      return res.send("❌ Missing order ID");
    }

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", Number(orderId))
      .maybeSingle();

    console.log("ORDER:", order);

    if (!order) {
      return res.send("❌ Order not found");
    }

    // ACTIVATE TASK
    await supabase.from("orders")
      .update({
        payment_status: "paid",
        status: "in_progress"
      })
      .eq("id", Number(orderId));

    // RUNNER
    if (order.runner_id) {

      await bot.sendMessage(
        order.runner_id,
`💰 Payment received!

📦 Task is now active.
You can now chat with the user.`,
{
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "✅ End Task",
          callback_data: `end_${order.id}`
        }
      ]
    ]
  }
});

    }

    // USER
    await bot.sendMessage(
      order.user_id,
`✅ Payment confirmed!

🤝 You can now chat with your Helper.`,
{
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "✅ End Task",
          callback_data: `end_${order.id}`
        }
      ]
    ]
  }
});

    return res.send("✅ Payment successful");

  } catch (err) {

    console.log("PAYMENT SUCCESS ERROR:", err.message);

    return res.send("❌ Payment error");
  }

});

// ================= SERVER =================
app.listen(3000, () => {
  console.log("🌐 Server running on port 3000");
});
