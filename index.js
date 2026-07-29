// Required env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, RUNNER_GROUP_ID,
// BASE_URL, FLW_WEBHOOK_SECRET

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const express = require("express");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;
const GIGS_TOPIC_ID = 2;
const BASE_URL = process.env.BASE_URL;
const MIN_PRICE = 50;
const SUPPORT_EMAIL = "helply.cu@gmail.com";

const TERMS_TEXT = `📜 *Helply Terms & Conditions*

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

By continuing, you agree to these Terms & Conditions.`;

// ================= STATE =================
// Single source of truth for "what is this user in the middle of doing".
// pendingState[userId] = { mode, ...context }
// modes: "location" | "counter" | "runner_counter" | "offer_amount"
// This replaces the old pendingCounters / pendingRunnerCounters / pendingOrders
// objects, which could get out of sync and leave users permanently stuck.
const pendingState = {};

function clearPendingState(userId) {
  delete pendingState[userId];
}

// ================= HELPERS =================

async function isBusy(userId) {
  const { data } = await supabase
    .from("orders")
    .select("id, status")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .in("status", ["matched", "in_progress"]);
  return !!(data && data.length > 0);
}

// True while the user has an offer sitting in negotiation (before it's
// accepted/rejected). Used to stop stray messages from being treated as a
// brand-new task request while a negotiation is still open.
async function hasActiveNegotiation(userId) {
  const { data } = await supabase
    .from("offers")
    .select("id")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .limit(1);
  return !!(data && data.length > 0);
}

async function getOffer(offerId) {
  const { data } = await supabase.from("offers").select("*").eq("id", offerId).maybeSingle();
  return data;
}

async function getOrder(orderId) {
  const { data } = await supabase.from("orders").select("*").eq("id", Number(orderId)).maybeSingle();
  return data;
}

function offerButtons(offerId, forRunner) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Accept", callback_data: `accept_${offerId}` }],
        [{ text: "💬 Counter", callback_data: forRunner ? `counter_runner_${offerId}` : `counter_${offerId}` }],
        [{ text: "❌ Reject", callback_data: `reject_${offerId}` }]
      ]
    }
  };
}

async function generateUniqueTaskId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = Math.floor(100000 + Math.random() * 900000);
    const { data } = await supabase.from("orders").select("id").eq("id", candidate).maybeSingle();
    if (!data) return candidate;
  }
  throw new Error("Could not generate a unique task ID after 5 attempts");
}

async function denyCallback(q, text = "❌ You can't do that") {
  return bot.answerCallbackQuery(q.id, { text, show_alert: true });
}

async function sendOfferAdjuster(chatId, taskId, price, editMessageId) {
  const text = `💰 Set your offer ₦${price}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "-1000", callback_data: `adj_${taskId}_${price}_-1000` },
        { text: "-500", callback_data: `adj_${taskId}_${price}_-500` },
        { text: "-50", callback_data: `adj_${taskId}_${price}_-50` }
      ],
      [
        { text: "+50", callback_data: `adj_${taskId}_${price}_50` },
        { text: "+500", callback_data: `adj_${taskId}_${price}_500` },
        { text: "+1000", callback_data: `adj_${taskId}_${price}_1000` }
      ],
      [{ text: "✅ Submit Offer", callback_data: `submit_${taskId}_${price}` }]
    ]
  };

  if (editMessageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, reply_markup: keyboard });
  }
  return bot.sendMessage(chatId, text, { reply_markup: keyboard });
}

// ================= START / CANCEL =================

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();
  const username = msg.from.username || "";

  let { data: user } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();

  if (!user) {
    await supabase.from("users").insert([{ id: userId, username, accepted_terms: false, banned: false }]);
    user = { id: userId, accepted_terms: false };
  }

  if (!user.accepted_terms) {
    return bot.sendMessage(userId, TERMS_TEXT, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Accept", callback_data: "accept_terms" },
          { text: "❌ Decline", callback_data: "decline_terms" }
        ]]
      }
    });
  }

  clearPendingState(userId);
  return bot.sendMessage(userId, "🚀 Welcome back to Helply\n\nSend your request");
});

// Escape hatch: previously there was no way to unstick a user whose
// pending state got out of sync. Now they can always reset with /cancel.
bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id.toString();
  if (pendingState[userId]) {
    clearPendingState(userId);
    return bot.sendMessage(userId, "✅ Cancelled. Send a new request whenever you're ready.");
  }
  return bot.sendMessage(userId, "Nothing to cancel.");
});

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  let { data: user } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();
  let currentUser = user;

  if (!currentUser) {
    const { error } = await supabase
      .from("users")
      .insert([{ id: userId, username: msg.from.username || "", accepted_terms: true }]);

    if (error) {
      console.log("INSERT ERROR:", error.message);
      return bot.sendMessage(userId, "❌ Error creating account");
    }
    currentUser = { id: userId, accepted_terms: true };
  }

  if (!currentUser.accepted_terms) {
    return bot.sendMessage(userId, "⚠️ Please accept terms using /start");
  }

  const state = pendingState[userId];

  // ===== USER COUNTER =====
  if (state?.mode === "counter") {
    const counterPrice = Number(text);
    if (isNaN(counterPrice) || counterPrice < MIN_PRICE) {
      return bot.sendMessage(userId, `❌ Enter a valid amount (minimum ₦${MIN_PRICE}), or /cancel`);
    }

    const offer = await getOffer(state.offerId);
    if (!offer) {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ This offer no longer exists.");
    }

    await supabase.from("offers").update({ current_price: counterPrice }).eq("id", state.offerId);
    clearPendingState(userId);

    await bot.sendMessage(
      offer.runner_id,
      `💬 User countered your offer\n\n💰 New price: ₦${counterPrice}`,
      offerButtons(state.offerId, true)
    );
    return;
  }

  // ===== RUNNER COUNTER =====
  if (state?.mode === "runner_counter") {
    const newPrice = Number(text);
    if (isNaN(newPrice) || newPrice < MIN_PRICE) {
      return bot.sendMessage(userId, `❌ Enter a valid amount (minimum ₦${MIN_PRICE}), or /cancel`);
    }

    const offer = await getOffer(state.offerId);
    if (!offer) {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ This offer no longer exists.");
    }

    await supabase.from("offers").update({ current_price: newPrice }).eq("id", state.offerId);
    clearPendingState(userId);

    await bot.sendMessage(
      offer.user_id,
      `💬 Runner updated the offer\n\n💰 New price: ₦${newPrice}`,
      offerButtons(state.offerId, false)
    );
    return;
  }

  // ===== RUNNER TYPING A STARTING OFFER AMOUNT =====
  if (state?.mode === "offer_amount") {
    const price = Number(text);
    if (isNaN(price) || price < MIN_PRICE) {
      return bot.sendMessage(userId, `❌ Enter a valid amount (minimum ₦${MIN_PRICE}), or /cancel`);
    }

    const order = await getOrder(state.taskId);
    if (!order || order.status !== "open") {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ This request is no longer available.");
    }

    clearPendingState(userId);
    return sendOfferAdjuster(userId, state.taskId, price);
  }

  // ===== LOCATION STEP =====
  if (state?.mode === "location") {
    const requestText = state.request;
    const locationText = text;

    let taskId;
    try {
      taskId = await generateUniqueTaskId();
    } catch (e) {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ Something went wrong creating your request. Please try again.");
    }

    const { error } = await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId,
      user_username: msg.from.username || "",
      request_text: requestText,
      delivery_location: locationText,
      status: "open",
      payment_status: "pending"
    }]);

    clearPendingState(userId);

    if (error) {
      console.log("ORDER INSERT ERROR:", error.message);
      return bot.sendMessage(userId, "❌ Something went wrong creating your request. Please try again.");
    }

    await bot.sendMessage(
      userId,
      `✅ Request sent successfully!\n\n🆔 Request ID: ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}`
    );

    await bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW REQUEST\n\n🆔 ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}`,
      {
        message_thread_id: GIGS_TOPIC_ID,
        reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${taskId}` }]] }
      }
    );
    return;
  }

  // ===== ACTIVE CHAT RELAY =====
  const { data: active } = await supabase
    .from("orders")
    .select("*")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .eq("status", "in_progress")
    .maybeSingle();

  if (active) {
    const receiver = userId === active.user_id ? active.runner_id : active.user_id;
    return bot.sendMessage(receiver, `💬 ${msg.from.first_name}: ${text}`);
  }

  // ===== GUARD: DON'T LET STRAY TEXT BECOME A NEW REQUEST MID-NEGOTIATION =====
  if (await hasActiveNegotiation(userId)) {
    return bot.sendMessage(userId, "💬 You have an active offer — use the buttons above to accept, counter, or reject it.");
  }

  // ===== NEW REQUEST =====
  if (await isBusy(userId)) {
    return bot.sendMessage(userId, "❌ Finish your current task first");
  }

  pendingState[userId] = { mode: "location", request: text };
  await bot.sendMessage(userId, "📍 Enter your delivery location:");
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {
    // ACCEPT / DECLINE TERMS
    if (data === "accept_terms") {
      await supabase.from("users").update({ accepted_terms: true }).eq("id", userId);
      await bot.sendMessage(userId, "🎉 You're in! Send your request");
      return bot.answerCallbackQuery(q.id);
    }
    if (data === "decline_terms") {
      await bot.sendMessage(userId, "You need to accept the terms to use Helply. Send /start when you're ready.");
      return bot.answerCallbackQuery(q.id);
    }

    // RUNNER STARTS AN OFFER -> ask for an amount instead of a hardcoded ₦500
    if (data.startsWith("offer_")) {
      const taskId = data.split("_")[1];

      if (await isBusy(userId)) {
        return denyCallback(q, "❌ Finish your current task first");
      }

      const order = await getOrder(taskId);
      if (!order) return denyCallback(q, "❌ Request not found");
      if (order.status !== "open") return denyCallback(q, "❌ This request is no longer available");
      if (order.user_id === userId) return denyCallback(q, "❌ You can't offer on your own request");

      pendingState[userId] = { mode: "offer_amount", taskId };
      await bot.sendMessage(userId, `💰 Enter your offer amount for request #${taskId}:`);
      return bot.answerCallbackQuery(q.id);
    }

    // ADJUST OFFER PRICE
    if (data.startsWith("adj_")) {
      const [, taskId, currentPriceStr, changeStr] = data.split("_");
      let newPrice = Number(currentPriceStr) + Number(changeStr);
      if (newPrice < MIN_PRICE) newPrice = MIN_PRICE;

      await sendOfferAdjuster(q.message.chat.id, taskId, newPrice, q.message.message_id);
      return bot.answerCallbackQuery(q.id);
    }

    // SUBMIT OFFER
    if (data.startsWith("submit_")) {
      const [, taskId, price] = data.split("_");

      const order = await getOrder(taskId);
      if (!order) return denyCallback(q, "❌ Request not found");
      if (order.status !== "open") return denyCallback(q, "❌ This request is no longer available");

      const offerId = uuidv4();
      await supabase.from("offers").insert([{
        id: offerId,
        order_id: String(taskId),
        user_id: order.user_id,
        runner_id: userId,
        runner_name: q.from.first_name,
        runner_username: q.from.username || "",
        current_price: Number(price)
      }]);

      const { data: offers } = await supabase.from("offers").select("*").eq("order_id", String(taskId));
      const buttons = offers.map(o => [{ text: `${o.runner_name} - ₦${o.current_price}`, callback_data: `view_${o.id}` }]);

      await bot.sendMessage(order.user_id, "💰 Offers:", { reply_markup: { inline_keyboard: buttons } });
      await bot.sendMessage(
        userId,
        `⏳ Offer submitted successfully\n\n💰 Your Offer: ₦${price}\n\nWaiting for the user to accept, counter, or reject your offer.`
      );

      return bot.answerCallbackQuery(q.id);
    }

    // VIEW OFFER
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];
      const o = await getOffer(id);
      if (!o) return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId) return denyCallback(q);

      await bot.sendMessage(userId, `${o.runner_name} - ₦${o.current_price}`, offerButtons(id, false));
      return bot.answerCallbackQuery(q.id);
    }

    // USER STARTS A COUNTER (must check before the runner-counter branch below)
    if (data.startsWith("counter_") && !data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[1];
      const o = await getOffer(offerId);
      if (!o) return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId) return denyCallback(q);

      pendingState[userId] = { mode: "counter", offerId };
      await bot.sendMessage(userId, "💬 Enter your counter offer amount:");
      return bot.answerCallbackQuery(q.id);
    }

    // RUNNER COUNTERS BACK
    if (data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[2];
      const o = await getOffer(offerId);
      if (!o) return denyCallback(q, "❌ Offer not found");
      if (o.runner_id !== userId) return denyCallback(q);

      pendingState[userId] = { mode: "runner_counter", offerId };
      await bot.sendMessage(userId, "💬 Enter your new offer amount:");
      return bot.answerCallbackQuery(q.id);
    }

    // REJECT OFFER
    if (data.startsWith("reject_")) {
      const offerId = data.split("_")[1];
      const o = await getOffer(offerId);
      if (!o) return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId && o.runner_id !== userId) return denyCallback(q);

      await supabase.from("offers").delete().eq("id", offerId);

      // Clear both sides so nobody is left in a dead negotiation state.
      clearPendingState(o.user_id);
      clearPendingState(o.runner_id);

      const rejecterIsRunner = o.runner_id === userId;
      await bot.sendMessage(o.user_id, rejecterIsRunner ? "❌ The runner rejected the offer." : "❌ You rejected the offer.");
      await bot.sendMessage(o.runner_id, rejecterIsRunner ? "❌ You rejected the offer." : "❌ The user rejected your offer.");

      return bot.answerCallbackQuery(q.id);
    }

    // ACCEPT OFFER
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];
      const o = await getOffer(id);
      if (!o) return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId && o.runner_id !== userId) return denyCallback(q);

      const order = await getOrder(o.order_id);
      if (!order || order.status !== "open") return denyCallback(q, "❌ This request is no longer available");

      const runnerFee = Number(o.current_price);
      const runnerPayout = Math.round(runnerFee * 0.9);
      const userPrice = Math.round(runnerFee * 1.3);

      await supabase.from("orders").update({
        runner_id: o.runner_id,
        runner_username: o.runner_username,
        agreed_price: runnerFee,
        runner_payout: runnerPayout,
        total_price: userPrice,
        status: "matched",
        payment_status: "pending"
      }).eq("id", Number(o.order_id));

      await supabase.from("offers").delete().eq("order_id", String(o.order_id));

      clearPendingState(o.user_id);
      clearPendingState(o.runner_id);

      const link = `${BASE_URL}/create-payment?orderId=${o.order_id}`;

      await bot.sendMessage(
        o.runner_id,
        "📦 Task assigned\n\n⏳ Waiting for user payment...",
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Task", callback_data: `cancel_${o.order_id}` }]] } }
      );
      await bot.sendMessage(o.user_id, `💳 Pay ₦${userPrice}\n\n${link}`);

      return bot.answerCallbackQuery(q.id);
    }

    // CANCEL TASK
    if (data.startsWith("cancel_")) {
      const id = data.split("_")[1];
      const order = await getOrder(id);
      if (!order) return denyCallback(q, "❌ Order not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);

      if (order.payment_status === "paid") {
        return denyCallback(q, "❌ Cannot cancel after payment");
      }

      const cancellerIsRunner = order.runner_id === userId;

      await supabase.from("orders").update({
        runner_id: null,
        runner_username: null,
        agreed_price: null,
        runner_payout: null,
        total_price: null,
        status: "open",
        payment_status: "pending"
      }).eq("id", Number(id));

      await supabase.from("offers").delete().eq("order_id", String(id));

      await bot.sendMessage(
        RUNNER_GROUP_ID,
        `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n📌 ${order.delivery_location}`,
        {
          message_thread_id: GIGS_TOPIC_ID,
          reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${order.id}` }]] }
        }
      );

      // Message each side accurately instead of always blaming the runner.
      await bot.sendMessage(
        order.user_id,
        cancellerIsRunner
          ? "⚠️ Your Helper cancelled the task.\n\nYour request has been reposted."
          : "❌ You cancelled the task."
      );
      if (order.runner_id) {
        await bot.sendMessage(
          order.runner_id,
          cancellerIsRunner ? "❌ You cancelled the task." : "❌ The user cancelled the task."
        );
      }

      return bot.answerCallbackQuery(q.id);
    }

    // END TASK
    if (data.startsWith("end_")) {
      const id = data.split("_")[1];
      const order = await getOrder(id);
      if (!order) return denyCallback(q, "❌ Task not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);

      await supabase.from("orders").update({ status: "completed" }).eq("id", Number(id));

      await bot.sendMessage(
        order.runner_id,
        `✅ Task ended successfully\n\n⚠️ For disputes or support:\n\n📧 ${SUPPORT_EMAIL}\n\nRequest ID: ${order.id}`
      );
      await bot.sendMessage(
        order.user_id,
        `✅ Task completed successfully\n\n⚠️ Need help or want to report an issue?\n\n📧 ${SUPPORT_EMAIL}\n\nInclude your Request ID: ${order.id}`
      );

      return bot.answerCallbackQuery(q.id, { text: "Task completed" });
    }
  } catch (err) {
    console.log("CALLBACK ERROR:", err.message);
    try {
      await bot.answerCallbackQuery(q.id, { text: "❌ Something went wrong" });
    } catch (e) {
      // callback query may already be too old to answer; nothing more to do
    }
  }
});

// ================= PAYMENT SUCCESS =================
app.get("/payment-success", async (req, res) => {
  return res.send(`
    <h1>✅ Payment Successful</h1>
    <p>You can return to Telegram.</p>
  `);
});

// ================= FLUTTERWAVE WEBHOOK =================
app.post("/flutterwave-webhook", async (req, res) => {
  try {
    const payload = req.body;
    const signature = req.headers["verif-hash"];

    if (signature !== process.env.FLW_WEBHOOK_SECRET) {
      return res.sendStatus(401);
    }

    console.log("🔥 WEBHOOK HIT");

    if (payload.event === "charge.completed" && payload.data.status === "successful") {
      const tx_ref = payload.data.tx_ref;
      const orderId = Number(tx_ref.split("_")[1]);

      const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
      if (!order) return res.sendStatus(200);
      if (order.payment_status === "paid") return res.sendStatus(200);

      await supabase.from("orders").update({ payment_status: "paid", status: "in_progress" }).eq("id", orderId);

      await bot.sendMessage(
        order.runner_id,
        "💰 Payment received!\n\n📦 Task is now active.",
        { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
      );
      await bot.sendMessage(order.user_id, "✅ Payment confirmed!\n\n🤝 You can now chat with your Helper.");

      console.log("✅ WEBHOOK ORDER UPDATED:", orderId);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log("❌ WEBHOOK ERROR:", err.message);
    return res.sendStatus(500);
  }
});

// ================= SERVER =================
app.listen(3000, () => {
  console.log("🌐 Server running on port 3000");
});
