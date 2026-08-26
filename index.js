// Required env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, RUNNER_GROUP_ID,
// BASE_URL, FLW_WEBHOOK_SECRET, RUNNER_SIGNUP_FORM_URL,
// ADMIN_DASHBOARD_USER, ADMIN_DASHBOARD_PASSWORD

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const express = require("express");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.setMyCommands([
  { command: "start",        description: "Get started / see the main menu" },
  { command: "help",         description: "See what Helply can do" },
  { command: "becomehelper", description: "Sign up to earn as a Helper" },
  { command: "stats",        description: "See your Helper earnings" },
  { command: "online",       description: "Set yourself as available for tasks" },
  { command: "offline",      description: "Stop receiving new task requests" },
  { command: "cancel",       description: "Cancel whatever you're doing" }
]).catch(err => console.log("Could not set command menu:", err.message));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const RUNNER_GROUP_ID        = process.env.RUNNER_GROUP_ID;
const GIGS_TOPIC_ID          = 2;
const BASE_URL               = process.env.BASE_URL;
const MIN_PRICE              = 50;
const SUPPORT_EMAIL          = "helply.cu@gmail.com";
const RUNNER_SIGNUP_FORM_URL = process.env.RUNNER_SIGNUP_FORM_URL || "https://forms.gle/P8Gb7zmVHQQEZ9JB7";
const STALE_REQUEST_MS       = 20 * 60 * 1000;

const TERMS_TEXT = `📜 *Helply Terms & Conditions*

*Account Use*
- Provide accurate information
- Keep your account secure
- You are responsible for activities on your account

*Requesting Services*
- Helply connects users with independent Helpers
- Availability may vary
- Prices may change due to demand or waiting time

*Payments*
- Payments are processed through supported methods
- Refunds are reviewed case-by-case

*User Conduct*
- Treat Helpers respectfully
- No threats, harassment, or unsafe behavior
- Provide accurate locations

*Cancellation Policy*
- Cancellation fees may apply after a Helper starts moving

*Account Suspension*
Accounts may be suspended for:
- Fraud
- Abuse
- Fake identity information
- Safety violations

*Liability*
- Helply connects users with independent Helpers
- Helply is not directly responsible for Helper conduct

By continuing, you agree to these Terms & Conditions.`;

// ================= STATE =================
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

async function hasActiveNegotiation(userId) {
  const { data } = await supabase
    .from("offers")
    .select("id")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .eq("negotiation_open", true)
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

async function getUser(userId) {
  const { data } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();
  return data;
}

async function logAdminAction(adminId, action, { orderId, targetUserId, note } = {}) {
  const { error } = await supabase.from("admin_actions").insert([{
    admin_id:       adminId,
    action,
    order_id:       orderId ? String(orderId) : null,
    target_user_id: targetUserId || null,
    note:           note || null
  }]);
  if (error) console.log("ADMIN ACTION LOG ERROR:", error.message);
}

function banMessage(user) {
  return `🚫 Your Helply account has been suspended.${user?.ban_reason ? `\n\nReason: ${user.ban_reason}` : ""}\n\nContact ${SUPPORT_EMAIL} if you think this is a mistake.`;
}

function formatNaira(n) {
  return `₦${Number(n || 0).toLocaleString("en-NG")}`;
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

// ================= RATINGS =================

async function getAvgRating(userId) {
  const { data } = await supabase.from("ratings").select("rating").eq("rated_id", userId);
  if (!data || data.length === 0) return null;
  const avg = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
  return { avg: Math.round(avg * 10) / 10, count: data.length };
}

async function ratingLabelFor(userId) {
  const r = await getAvgRating(userId);
  return r ? ` ⭐${r.avg} (${r.count})` : "";
}

async function hasRated(orderId, raterId) {
  const { data } = await supabase
    .from("ratings")
    .select("id")
    .eq("order_id", String(orderId))
    .eq("rater_id", raterId)
    .maybeSingle();
  return !!data;
}

function ratingButtons(orderId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [1, 2, 3, 4, 5].map(n => ({
          text: "⭐".repeat(n),
          callback_data: `rate_${orderId}_${n}`
        }))
      ]
    }
  };
}

// ================= STATS =================

function startOfWeek(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

async function computeRunnerStats(userId) {
  const now        = new Date();
  const weekStart  = startOfWeek(now);
  const monthStart = startOfMonth(now);

  const { data: completed, error: cErr } = await supabase
    .from("orders")
    .select("runner_payout, created_at")
    .eq("runner_id", userId)
    .eq("status", "completed");
  if (cErr) console.log("STATS COMPLETED ERROR:", cErr.message);

  const { data: pending, error: pErr } = await supabase
    .from("orders")
    .select("runner_payout")
    .eq("runner_id", userId)
    .eq("status", "in_progress")
    .eq("payment_status", "paid");
  if (pErr) console.log("STATS PENDING ERROR:", pErr.message);

  const rows        = completed || [];
  const pendingRows = pending   || [];

  const totalTasks      = rows.length;
  const totalEarned     = rows.reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);
  const weekEarned      = rows.filter(r => r.created_at && new Date(r.created_at) >= weekStart)
                              .reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);
  const monthEarned     = rows.filter(r => r.created_at && new Date(r.created_at) >= monthStart)
                              .reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);
  const avgPerTask      = totalTasks > 0 ? Math.round(totalEarned / totalTasks) : 0;
  const pendingCount    = pendingRows.length;
  const pendingEarnings = pendingRows.reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);

  return { totalTasks, totalEarned, weekEarned, monthEarned, avgPerTask, pendingCount, pendingEarnings };
}

async function formatRunnerStats(userId) {
  const stats  = await computeRunnerStats(userId);
  const rating = await getAvgRating(userId);

  let text = `📊 *Your Helper Stats*\n\n`;
  text += `✅ Tasks completed: *${stats.totalTasks}*\n`;
  text += `💰 Total earned: *${formatNaira(stats.totalEarned)}*\n`;
  text += `📈 Avg per task: *${formatNaira(stats.avgPerTask)}*\n`;
  text += `⭐ Rating: *${rating ? `${rating.avg} / 5 (${rating.count} reviews)` : "No ratings yet"}*\n\n`;
  text += `📅 This week: *${formatNaira(stats.weekEarned)}*\n`;
  text += `🗓️ This month: *${formatNaira(stats.monthEarned)}*`;

  if (stats.pendingCount > 0) {
    text += `\n\n⏳ Active: *${stats.pendingCount}* task(s) worth *${formatNaira(stats.pendingEarnings)}* once completed`;
  } else if (stats.totalTasks === 0) {
    text += `\n\nNo completed tasks yet — accept a request from the runner group to get started!`;
  }

  return text;
}

// ================= KEYBOARD BUILDERS =================

// negotiation_open, last_price, last_sender are now written on every
// counter so the DB always reflects who moved last and at what price.
// This means offer state survives a bot restart — on startup the bot
// can reconstruct who is mid-negotiation from the DB rather than from
// the in-memory pendingState object.

function offerButtons(offerId, forRunner) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Accept",  callback_data: `accept_${offerId}`  }],
        [{ text: "💬 Counter", callback_data: forRunner ? `counter_runner_${offerId}` : `counter_${offerId}` }],
        [{ text: "❌ Reject",  callback_data: `reject_${offerId}`  }]
      ]
    }
  };
}

async function sendOfferAdjuster(chatId, taskId, price, editMessageId) {
  const text     = `💰 Set your offer ₦${price}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "-1000", callback_data: `adj_${taskId}_${price}_-1000` },
        { text: "-500",  callback_data: `adj_${taskId}_${price}_-500`  },
        { text: "-50",   callback_data: `adj_${taskId}_${price}_-50`   }
      ],
      [
        { text: "+50",   callback_data: `adj_${taskId}_${price}_50`    },
        { text: "+500",  callback_data: `adj_${taskId}_${price}_500`   },
        { text: "+1000", callback_data: `adj_${taskId}_${price}_1000`  }
      ],
      [{ text: "✅ Submit Offer", callback_data: `submit_${taskId}_${price}` }]
    ]
  };

  if (editMessageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, reply_markup: keyboard });
  }
  return bot.sendMessage(chatId, text, { reply_markup: keyboard });
}

// ================= REPLY KEYBOARD =================

const BTN_BECOME_HELPER = "🏃 Become a Helper";
const BTN_STATS         = "📊 My Stats";
const BTN_HELP          = "❓ Help";
const BTN_CANCEL        = "❌ Cancel";

const mainReplyKeyboard = {
  reply_markup: {
    keyboard: [
      [BTN_BECOME_HELPER, BTN_STATS],
      [BTN_HELP,          BTN_CANCEL]
    ],
    resize_keyboard: true,
    is_persistent:  true
  }
};

// ================= STALE REQUEST CHECKER =================

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - STALE_REQUEST_MS).toISOString();

    const { data: stale } = await supabase
      .from("orders")
      .select("id, user_id, request_text")
      .eq("status", "open")
      .eq("nudged", false)
      .lt("created_at", cutoff);

    if (!stale || stale.length === 0) return;

    for (const order of stale) {
      const { data: offers } = await supabase
        .from("offers")
        .select("id")
        .eq("order_id", String(order.id))
        .limit(1);

      if (offers && offers.length > 0) continue;

      await supabase.from("orders").update({ nudged: true }).eq("id", order.id);

      await bot.sendMessage(
        order.user_id,
        `⏳ Your request has been open for 20 minutes with no offers yet.\n\n📦 ${order.request_text}\n\nWould you like to cancel it?`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "❌ Cancel Request", callback_data: `cancelreq_${order.id}` }]]
          }
        }
      );
    }
  } catch (err) {
    console.log("STALE CHECKER ERROR:", err.message);
  }
}, 5 * 60 * 1000);

// ================= COMMAND HANDLERS =================

async function sendBecomeHelperMessage(userId) {
  return bot.sendMessage(
    userId,
    "🏃 Want to earn money completing tasks on campus?\n\nFill out the Helper signup form to get started:",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "📝 Sign up as a Helper", url: RUNNER_SIGNUP_FORM_URL }]]
      }
    }
  );
}

async function handleCancelCommand(userId) {
  if (pendingState[userId]) {
    clearPendingState(userId);
    return bot.sendMessage(userId, "✅ Cancelled. Send a new request whenever you're ready.");
  }
  return bot.sendMessage(userId, "Nothing to cancel.");
}

async function sendStatsMessage(userId) {
  const user = await getUser(userId);
  if (!user) return bot.sendMessage(userId, "⚠️ Send /start first.");
  try {
    const text = await formatRunnerStats(userId);
    return bot.sendMessage(userId, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.log("STATS ERROR:", err.message);
    return bot.sendMessage(userId, "❌ Couldn't load your stats right now. Try again shortly.");
  }
}

async function sendHelpMessage(userId) {
  return bot.sendMessage(
    userId,
    `🤖 *What Helply can do*

*Getting things done*
Just type what you need — I'll ask for your location and post it to our Helpers.

*Commands*
🏃 /becomehelper — Sign up to earn as a Helper
📊 /stats — See your Helper earnings & rating
🟢 /online — Mark yourself available for tasks
🔴 /offline — Stop receiving new requests
❌ /cancel — Cancel whatever you're doing
/start — Main menu
/help — This message

Need a hand? 📧 ${SUPPORT_EMAIL}`,
    { parse_mode: "Markdown" }
  );
}

// ================= /start =================

bot.onText(/\/start/, async (msg) => {
  const userId   = msg.from.id.toString();
  const username = msg.from.username || "";

  let { data: user } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();

  if (!user) {
    await supabase.from("users").insert([{ id: userId, username, accepted_terms: false, banned: false }]);
    user = { id: userId, accepted_terms: false };
  }

  if (user.banned) return bot.sendMessage(userId, banMessage(user));

  if (!user.accepted_terms) {
    return bot.sendMessage(userId, TERMS_TEXT, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Accept",  callback_data: "accept_terms"  },
          { text: "❌ Decline", callback_data: "decline_terms" }
        ]]
      }
    });
  }

  clearPendingState(userId);
  return bot.sendMessage(
    userId,
    "🚀 Welcome back to Helply\n\nSend your request, or use the buttons below anytime.",
    mainReplyKeyboard
  );
});

bot.onText(/\/becomehelper/, (msg) => sendBecomeHelperMessage(msg.from.id.toString()));
bot.onText(/\/cancel/,       (msg) => handleCancelCommand(msg.from.id.toString()));
bot.onText(/\/stats/,        (msg) => sendStatsMessage(msg.from.id.toString()));
bot.onText(/\/help/,         (msg) => sendHelpMessage(msg.from.id.toString()));

bot.onText(/\/online/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const userId = msg.from.id.toString();
  await supabase.from("users").update({ is_online: true }).eq("id", userId);
  return bot.sendMessage(userId, "🟢 You're online. You'll receive new task requests.");
});

bot.onText(/\/offline/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const userId = msg.from.id.toString();
  await supabase.from("users").update({ is_online: false }).eq("id", userId);
  return bot.sendMessage(userId, "🔴 You're offline. New requests won't come to you until you go /online.");
});

// ================= MESSAGE =================

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id.toString();
  const text   = msg.text.trim();

  let { data: user } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();
  let currentUser = user;

  if (!currentUser) {
    const { error } = await supabase.from("users").insert([{
      id:             userId,
      username:       msg.from.username || "",
      accepted_terms: true
    }]);
    if (error) {
      console.log("INSERT ERROR:", error.message);
      return bot.sendMessage(userId, "❌ Error creating account");
    }
    currentUser = { id: userId, accepted_terms: true };
  }

  if (currentUser.banned)          return bot.sendMessage(userId, banMessage(currentUser));
  if (!currentUser.accepted_terms) return bot.sendMessage(userId, "⚠️ Please accept terms using /start");

  // Reply keyboard button taps — always available regardless of state
  if (text === BTN_BECOME_HELPER) return sendBecomeHelperMessage(userId);
  if (text === BTN_STATS)         return sendStatsMessage(userId);
  if (text === BTN_HELP)          return sendHelpMessage(userId);
  if (text === BTN_CANCEL)        return handleCancelCommand(userId);

  const state = pendingState[userId];

  // ── User counter ──────────────────────────────────────────────────────────
  if (state?.mode === "counter") {
    const counterPrice = Number(text);
    if (isNaN(counterPrice) || counterPrice < MIN_PRICE) {
      return bot.sendMessage(userId, `❌ Enter a valid amount (minimum ₦${MIN_PRICE}), or tap Cancel`);
    }

    const offer = await getOffer(state.offerId);
    if (!offer) {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ This offer no longer exists.");
    }

    // Update price AND negotiation tracking columns
    await supabase.from("offers").update({
      current_price:    counterPrice,
      last_price:       counterPrice,
      last_sender:      "user",
      negotiation_open: true
    }).eq("id", state.offerId);

    clearPendingState(userId);

    await bot.sendMessage(
      offer.runner_id,
      `💬 User countered your offer\n\n💰 New price: ₦${counterPrice}`,
      offerButtons(state.offerId, true)
    );
    return;
  }

  // ── Runner counter ────────────────────────────────────────────────────────
  if (state?.mode === "runner_counter") {
    const newPrice = Number(text);
    if (isNaN(newPrice) || newPrice < MIN_PRICE) {
      return bot.sendMessage(userId, `❌ Enter a valid amount (minimum ₦${MIN_PRICE}), or tap Cancel`);
    }

    const offer = await getOffer(state.offerId);
    if (!offer) {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ This offer no longer exists.");
    }

    // Update price AND negotiation tracking columns
    await supabase.from("offers").update({
      current_price:    newPrice,
      last_price:       newPrice,
      last_sender:      "runner",
      negotiation_open: true
    }).eq("id", state.offerId);

    clearPendingState(userId);

    await bot.sendMessage(
      offer.user_id,
      `💬 Runner updated the offer\n\n💰 New price: ₦${newPrice}`,
      offerButtons(state.offerId, false)
    );
    return;
  }

  // ── Runner typing a starting offer amount ─────────────────────────────────
  if (state?.mode === "offer_amount") {
    const price = Number(text);
    if (isNaN(price) || price < MIN_PRICE) {
      return bot.sendMessage(userId, `❌ Enter a valid amount (minimum ₦${MIN_PRICE}), or tap Cancel`);
    }

    const order = await getOrder(state.taskId);
    if (!order || order.status !== "open") {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ This request is no longer available.");
    }

    clearPendingState(userId);
    return sendOfferAdjuster(userId, state.taskId, price);
  }

  // ── Location step ─────────────────────────────────────────────────────────
  if (state?.mode === "location") {
    const requestText  = state.request;
    const locationText = text;

    let taskId;
    try {
      taskId = await generateUniqueTaskId();
    } catch (e) {
      clearPendingState(userId);
      return bot.sendMessage(userId, "❌ Something went wrong creating your request. Please try again.");
    }

    const { error } = await supabase.from("orders").insert([{
      id:                taskId,
      user_id:           userId,
      user_username:     msg.from.username || "",
      request_text:      requestText,
      delivery_location: locationText,
      status:            "open",
      payment_status:    "pending",
      nudged:            false
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

  // ── Active chat relay ─────────────────────────────────────────────────────
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

  // ── Guard: stray text during active negotiation ───────────────────────────
  if (await hasActiveNegotiation(userId)) {
    return bot.sendMessage(
      userId,
      "💬 You have an active offer — use the buttons to accept, counter, or reject it.\n\nTap ❌ Cancel if you want to start over."
    );
  }

  // ── New request ───────────────────────────────────────────────────────────
  if (await isBusy(userId)) {
    return bot.sendMessage(userId, "❌ Finish your current task first");
  }

  pendingState[userId] = { mode: "location", request: text };
  await bot.sendMessage(userId, "📍 Enter your delivery location:");
});

// ================= CALLBACK =================

bot.on("callback_query", async (q) => {
  const data   = q.data;
  const userId = q.from.id.toString();

  try {
    const requester = await getUser(userId);
    if (requester?.banned) return denyCallback(q, "🚫 Your account has been suspended.");

    // ACCEPT / DECLINE TERMS
    if (data === "accept_terms") {
      await supabase.from("users").update({ accepted_terms: true }).eq("id", userId);
      await bot.sendMessage(userId, "🎉 You're in! Send your request, or use the buttons below.", mainReplyKeyboard);
      return bot.answerCallbackQuery(q.id);
    }
    if (data === "decline_terms") {
      await bot.sendMessage(userId, "You need to accept the terms to use Helply. Send /start when you're ready.");
      return bot.answerCallbackQuery(q.id);
    }

    // CANCEL REQUEST (from stale nudge)
    if (data.startsWith("cancelreq_")) {
      const id    = data.split("_")[1];
      const order = await getOrder(id);
      if (!order)                   return denyCallback(q, "❌ Request not found");
      if (order.user_id !== userId) return denyCallback(q);
      if (order.status !== "open")  return denyCallback(q, "❌ This request can no longer be cancelled");

      await supabase.from("orders").update({ status: "cancelled" }).eq("id", Number(id));
      await supabase.from("offers").delete().eq("order_id", String(id));

      await bot.sendMessage(userId, "❌ Request cancelled.");
      return bot.answerCallbackQuery(q.id);
    }

    // RUNNER STARTS AN OFFER
    if (data.startsWith("offer_")) {
      const taskId = data.split("_")[1];

      if (await isBusy(userId)) return denyCallback(q, "❌ Finish your current task first");

      const order = await getOrder(taskId);
      if (!order)                   return denyCallback(q, "❌ Request not found");
      if (order.status !== "open")  return denyCallback(q, "❌ This request is no longer available");
      if (order.user_id === userId) return denyCallback(q, "❌ You can't offer on your own request");

      const { data: runner } = await supabase.from("users").select("is_online").eq("id", userId).maybeSingle();
      if (runner && runner.is_online === false) {
        return denyCallback(q, "❌ You're offline. Send /online to start receiving tasks.");
      }

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
      if (!order)                  return denyCallback(q, "❌ Request not found");
      if (order.status !== "open") return denyCallback(q, "❌ This request is no longer available");

      const offerId = uuidv4();

      // negotiation_open starts false — it becomes true only when
      // either side sends a counter. last_price and last_sender are
      // set on the initial submit so the DB has a baseline.
      await supabase.from("offers").insert([{
        id:               offerId,
        order_id:         String(taskId),
        user_id:          order.user_id,
        runner_id:        userId,
        runner_name:      q.from.first_name,
        runner_username:  q.from.username || "",
        current_price:    Number(price),
        last_price:       Number(price),
        last_sender:      "runner",
        negotiation_open: false
      }]);

      const { data: offers } = await supabase.from("offers").select("*").eq("order_id", String(taskId));
      const buttons = await Promise.all(
        offers.map(async o => {
          const label = await ratingLabelFor(o.runner_id);
          return [{ text: `${o.runner_name}${label} — ₦${o.current_price}`, callback_data: `view_${o.id}` }];
        })
      );

      await bot.sendMessage(order.user_id, "💰 New offer received:", { reply_markup: { inline_keyboard: buttons } });
      await bot.sendMessage(userId, `⏳ Offer submitted\n\n💰 Your offer: ₦${price}\n\nWaiting for the user to respond.`);

      return bot.answerCallbackQuery(q.id);
    }

    // VIEW OFFER
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];
      const o  = await getOffer(id);
      if (!o)                   return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId) return denyCallback(q);

      const label = await ratingLabelFor(o.runner_id);
      await bot.sendMessage(userId, `${o.runner_name}${label} — ₦${o.current_price}`, offerButtons(id, false));
      return bot.answerCallbackQuery(q.id);
    }

    // USER COUNTER
    if (data.startsWith("counter_") && !data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[1];
      const o       = await getOffer(offerId);
      if (!o)                   return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId) return denyCallback(q);

      // Block the user from countering twice in a row
      if (o.last_sender === "user" && o.negotiation_open) {
        return denyCallback(q, "⏳ Waiting for the runner to respond to your last counter.");
      }

      pendingState[userId] = { mode: "counter", offerId };
      await bot.sendMessage(userId, "💬 Enter your counter offer amount:");
      return bot.answerCallbackQuery(q.id);
    }

    // RUNNER COUNTER
    if (data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[2];
      const o       = await getOffer(offerId);
      if (!o)                     return denyCallback(q, "❌ Offer not found");
      if (o.runner_id !== userId) return denyCallback(q);

      // Block the runner from countering twice in a row
      if (o.last_sender === "runner" && o.negotiation_open) {
        return denyCallback(q, "⏳ Waiting for the user to respond to your last counter.");
      }

      pendingState[userId] = { mode: "runner_counter", offerId };
      await bot.sendMessage(userId, "💬 Enter your new offer amount:");
      return bot.answerCallbackQuery(q.id);
    }

    // REJECT OFFER
    if (data.startsWith("reject_")) {
      const offerId = data.split("_")[1];
      const o       = await getOffer(offerId);
      if (!o)                                             return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId && o.runner_id !== userId) return denyCallback(q);

      await supabase.from("offers").delete().eq("id", offerId);
      clearPendingState(o.user_id);
      clearPendingState(o.runner_id);

      const rejecterIsRunner = o.runner_id === userId;
      await bot.sendMessage(o.user_id,   rejecterIsRunner ? "❌ The runner rejected the offer." : "❌ You rejected the offer.");
      await bot.sendMessage(o.runner_id, rejecterIsRunner ? "❌ You rejected the offer."        : "❌ The user rejected your offer.");

      return bot.answerCallbackQuery(q.id);
    }

    // ACCEPT OFFER
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];
      const o  = await getOffer(id);
      if (!o)                                             return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId && o.runner_id !== userId) return denyCallback(q);

      const order = await getOrder(o.order_id);
      if (!order || order.status !== "open") return denyCallback(q, "❌ This request is no longer available");

      const runnerFee    = Number(o.current_price);
      const runnerPayout = Math.round(runnerFee * 0.9);
      const userPrice    = Math.round(runnerFee * 1.3);

      await supabase.from("orders").update({
        runner_id:       o.runner_id,
        runner_username: o.runner_username,
        agreed_price:    runnerFee,
        runner_payout:   runnerPayout,
        total_price:     userPrice,
        status:          "matched",
        payment_status:  "pending"
      }).eq("id", Number(o.order_id));

      // Close negotiation and wipe all offers for this order
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

    // CANCEL TASK (post-match, pre-payment)
    if (data.startsWith("cancel_")) {
      const id    = data.split("_")[1];
      const order = await getOrder(id);
      if (!order)                                             return denyCallback(q, "❌ Order not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);
      if (order.payment_status === "paid")                    return denyCallback(q, "❌ Cannot cancel after payment");

      const cancellerIsRunner = order.runner_id === userId;

      await supabase.from("orders").update({
        runner_id:       null,
        runner_username: null,
        agreed_price:    null,
        runner_payout:   null,
        total_price:     null,
        status:          "open",
        payment_status:  "pending",
        nudged:          false
      }).eq("id", Number(id));

      await supabase.from("offers").delete().eq("order_id", String(id));

      await bot.sendMessage(
        RUNNER_GROUP_ID,
        `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n\n📦 Request:\n${order.request_text}\n\n📍 Location:\n${order.delivery_location}`,
        {
          message_thread_id: GIGS_TOPIC_ID,
          reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${order.id}` }]] }
        }
      );

      await bot.sendMessage(
        order.user_id,
        cancellerIsRunner
          ? "⚠️ Your Helper cancelled the task.\n\nYour request has been reposted — a new Helper can pick it up."
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
      const id    = data.split("_")[1];
      const order = await getOrder(id);
      if (!order)                                             return denyCallback(q, "❌ Task not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);

      await supabase.from("orders").update({ status: "completed" }).eq("id", Number(id));

      await bot.sendMessage(
        order.runner_id,
        `✅ Task ended successfully\n\n⚠️ For disputes or support:\n📧 ${SUPPORT_EMAIL}\n\nRequest ID: ${order.id}`
      );
      await bot.sendMessage(
        order.user_id,
        `✅ Task completed successfully\n\n⚠️ Need help or want to report an issue?\n📧 ${SUPPORT_EMAIL}\n\nInclude your Request ID: ${order.id}`
      );

      await bot.sendMessage(order.user_id,  "⭐ How was your Helper?", ratingButtons(order.id));
      await bot.sendMessage(order.runner_id, "⭐ How was this user?",   ratingButtons(order.id));

      return bot.answerCallbackQuery(q.id, { text: "Task completed" });
    }

    // RATE
    if (data.startsWith("rate_")) {
      const [, orderId, starsStr] = data.split("_");
      const stars = Number(starsStr);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return denyCallback(q, "❌ Invalid rating");

      const order = await getOrder(orderId);
      if (!order)                                             return denyCallback(q, "❌ Task not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);
      if (await hasRated(orderId, userId)) return denyCallback(q, "❌ You already rated this task");

      const ratedId = order.user_id === userId ? order.runner_id : order.user_id;

      await supabase.from("ratings").insert([{
        order_id: String(orderId),
        rater_id: userId,
        rated_id: ratedId,
        rating:   stars
      }]);

      await bot.editMessageText(`✅ Thanks! You gave ${"⭐".repeat(stars)}`, {
        chat_id:    q.message.chat.id,
        message_id: q.message.message_id
      });

      return bot.answerCallbackQuery(q.id, { text: "Rating submitted" });
    }

  } catch (err) {
    console.log("CALLBACK ERROR:", err.message);
    try {
      await bot.answerCallbackQuery(q.id, { text: "❌ Something went wrong" });
    } catch (e) {
      // query may be too old; nothing more to do
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
    const payload   = req.body;
    const signature = req.headers["verif-hash"];

    if (signature !== process.env.FLW_WEBHOOK_SECRET) return res.sendStatus(401);

    console.log("🔥 WEBHOOK HIT");

    if (payload.event === "charge.completed" && payload.data.status === "successful") {
      const tx_ref  = payload.data.tx_ref;
      const orderId = Number(tx_ref.split("_")[1]);

      const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
      if (!order)                          return res.sendStatus(200);
      if (order.payment_status === "paid") return res.sendStatus(200);

      await supabase.from("orders")
        .update({ payment_status: "paid", status: "in_progress" })
        .eq("id", orderId);

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

// ================= ADMIN DASHBOARD =================

const DASHBOARD_USER     = process.env.ADMIN_DASHBOARD_USER || "admin";
const DASHBOARD_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD;

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).send("Dashboard is not configured. Set ADMIN_DASHBOARD_PASSWORD.");
  }
  const authHeader = req.headers.authorization || "";
  const [scheme, encoded] = authHeader.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === DASHBOARD_USER && pass === DASHBOARD_PASSWORD) {
      req.dashboardAdmin = user;
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Helply Admin"');
  return res.status(401).send("Authentication required.");
}

app.use("/admin", requireDashboardAuth);

const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helply Admin</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --border:#262b36; --text:#e8eaed; --muted:#8b93a1;
          --yellow:#f5c542; --orange:#f59e42; --green:#4ade80; --red:#f87171; --blue:#60a5fa; --purple:#a78bfa; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
  header h1 { font-size:18px; margin:0; }
  main { padding:24px; max-width:1000px; margin:0 auto; }
  section { margin-bottom:32px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:10px 12px; font-size:13px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:#1c2028; cursor:pointer; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge.open        { background:rgba(245,197,66,0.15);  color:var(--yellow); }
  .badge.matched     { background:rgba(245,158,66,0.15);  color:var(--orange); }
  .badge.in_progress { background:rgba(74,222,128,0.15);  color:var(--green);  }
  .badge.completed   { background:rgba(96,165,250,0.15);  color:var(--blue);   }
  .badge.voided,
  .badge.refunded    { background:rgba(248,113,113,0.15); color:var(--red);    }
  button { font:inherit; cursor:pointer; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:600; }
  .btn-primary { background:var(--blue);   color:#0f1115; }
  .btn-warn    { background:var(--orange); color:#0f1115; }
  .btn-danger  { background:var(--red);    color:#0f1115; }
  .btn-purple  { background:var(--purple); color:#0f1115; }
  .btn-ghost   { background:transparent; border:1px solid var(--border); color:var(--text); }
  .btn-row     { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .empty       { color:var(--muted); font-size:13px; padding:16px; text-align:center; }
  .overlay     { position:fixed; inset:0; background:rgba(0,0,0,0.6); display:none; align-items:center; justify-content:center; padding:20px; }
  .overlay.show { display:flex; }
  .modal       { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px; max-width:480px; width:100%; max-height:85vh; overflow-y:auto; }
  .modal h3    { margin-top:0; }
  .modal .row  { display:flex; justify-content:space-between; font-size:13px; padding:6px 0; border-bottom:1px solid var(--border); }
  .modal .label { color:var(--muted); }
  .close-x     { float:right; background:none; color:var(--muted); padding:4px 8px; }
  input[type=text], textarea { width:100%; padding:8px 10px; background:#0f1115; border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; margin-bottom:8px; font-family:inherit; }
  textarea     { resize:vertical; min-height:80px; }
  .ban-form, .broadcast-form { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .ban-form input { flex:1; min-width:140px; margin-bottom:0; }
  .broadcast-form textarea { flex:1; margin-bottom:0; }
  .toast       { position:fixed; bottom:20px; right:20px; background:var(--card); border:1px solid var(--border); padding:12px 16px; border-radius:8px; font-size:13px; display:none; z-index:9999; }
  .toast.show  { display:block; }
  .broadcast-history { margin-top:16px; }
  .bc-item     { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:8px; font-size:13px; }
  .bc-item .bc-meta { color:var(--muted); font-size:11px; margin-top:4px; }
</style>
</head>
<body>

<header>
  <h1>🛠️ Helply Admin</h1>
  <button class="btn-ghost" onclick="loadAll()">⟳ Refresh</button>
</header>

<main>
  <section>
    <h2>Active Orders</h2>
    <div id="orders"></div>
  </section>

  <section>
    <h2>Broadcast Message</h2>
    <p style="font-size:13px;color:var(--muted);margin:0 0 8px">Sends a message to every user in the system.</p>
    <textarea id="broadcastMsg" placeholder="Type your message here..."></textarea>
    <div>
      <button class="btn-purple" onclick="sendBroadcast()">📢 Send to all users</button>
    </div>
    <div class="broadcast-history" id="broadcastHistory"></div>
  </section>

  <section>
    <h2>Banned Users</h2>
    <div id="banned"></div>
    <div class="ban-form">
      <input type="text" id="banUserId" placeholder="Telegram user ID to ban">
      <input type="text" id="banReason" placeholder="Reason (optional)">
      <button class="btn-danger" onclick="banUser()">Ban</button>
    </div>
  </section>
</main>

<div class="overlay" id="overlay">
  <div class="modal" id="modalBody"></div>
</div>
<div class="toast" id="toast"></div>

<script>
async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3500);
}

function naira(n) { return "₦" + Number(n || 0).toLocaleString("en-NG"); }
function closeModal() { document.getElementById("overlay").classList.remove("show"); }

async function loadOrders() {
  const container = document.getElementById("orders");
  container.innerHTML = "Loading...";
  try {
    const { orders } = await api("/admin/api/orders");
    if (!orders.length) { container.innerHTML = '<div class="empty">No active orders right now.</div>'; return; }
    let html = "<table><tr><th>ID</th><th>Status</th><th>Requester</th><th>Runner</th><th>Price</th></tr>";
    orders.forEach(o => {
      html += "<tr onclick=\"openOrder(" + o.id + ")\">" +
        "<td>#" + o.id + "</td>" +
        "<td><span class='badge " + o.status + "'>" + o.status + "</span></td>" +
        "<td>@" + (o.user_username || "?") + "</td>" +
        "<td>" + (o.runner_username ? "@" + o.runner_username : "—") + "</td>" +
        "<td>" + naira(o.total_price) + "</td></tr>";
    });
    html += "</table>";
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="empty">Error: ' + err.message + '</div>';
  }
}

async function loadBanned() {
  const container = document.getElementById("banned");
  container.innerHTML = "Loading...";
  try {
    const { users } = await api("/admin/api/users/banned");
    if (!users.length) { container.innerHTML = '<div class="empty">No banned users.</div>'; return; }
    let html = "<table><tr><th>User ID</th><th>Username</th><th>Reason</th><th></th></tr>";
    users.forEach(u => {
      html += "<tr><td>" + u.id + "</td><td>@" + (u.username || "unknown") + "</td><td>" + (u.ban_reason || "—") + "</td>" +
        "<td><button class='btn-ghost' onclick=\"unbanUser('" + u.id + "')\">Unban</button></td></tr>";
    });
    html += "</table>";
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="empty">Error: ' + err.message + '</div>';
  }
}

async function loadBroadcastHistory() {
  const container = document.getElementById("broadcastHistory");
  try {
    const { broadcasts } = await api("/admin/api/broadcasts");
    if (!broadcasts.length) { container.innerHTML = ''; return; }
    let html = '<div style="font-size:12px;color:var(--muted);margin:12px 0 6px">Recent broadcasts</div>';
    broadcasts.forEach(b => {
      const d = new Date(b.created_at).toLocaleString();
      html += "<div class='bc-item'>" + b.message + "<div class='bc-meta'>" + d + " · " + (b.sent_count || "?") + " recipients</div></div>";
    });
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '';
  }
}

async function openOrder(id) {
  try {
    const { order } = await api("/admin/api/orders/" + id);
    const buttons = [];
    if (order.status !== "completed") buttons.push("<button class='btn-primary' onclick=\"resolveOrder(" + id + ",'complete')\">✅ Force complete</button>");
    if (order.status === "matched" || order.status === "in_progress") buttons.push("<button class='btn-warn' onclick=\"resolveOrder(" + id + ",'reset')\">🔄 Reset to open</button>");
    if (order.payment_status === "paid") buttons.push("<button class='btn-warn' onclick=\"resolveOrder(" + id + ",'refund')\">💵 Mark refunded</button>");
    buttons.push("<button class='btn-danger' onclick=\"resolveOrder(" + id + ",'void')\">🗑 Void</button>");
    buttons.push("<button class='btn-ghost' onclick=\"banFromOrder('" + order.user_id + "'," + id + ")\">🚫 Ban requester</button>");
    if (order.runner_id) buttons.push("<button class='btn-ghost' onclick=\"banFromOrder('" + order.runner_id + "'," + id + ")\">🚫 Ban runner</button>");

    document.getElementById("modalBody").innerHTML =
      "<button class='close-x' onclick='closeModal()'>✕</button>" +
      "<h3>Order #" + order.id + "</h3>" +
      "<div class='row'><span class='label'>Status</span><span>" + order.status + " / " + order.payment_status + "</span></div>" +
      "<div class='row'><span class='label'>Requester</span><span>@" + (order.user_username || "unknown") + " (" + order.user_id + ")</span></div>" +
      "<div class='row'><span class='label'>Runner</span><span>" + (order.runner_id ? "@" + (order.runner_username || "unknown") + " (" + order.runner_id + ")" : "unassigned") + "</span></div>" +
      "<div class='row'><span class='label'>Request</span><span>" + (order.request_text || "—") + "</span></div>" +
      "<div class='row'><span class='label'>Location</span><span>" + (order.delivery_location || "—") + "</span></div>" +
      "<div class='row'><span class='label'>Agreed price</span><span>" + naira(order.agreed_price) + "</span></div>" +
      "<div class='row'><span class='label'>Runner payout</span><span>" + naira(order.runner_payout) + "</span></div>" +
      "<div class='row'><span class='label'>Total charged</span><span>" + naira(order.total_price) + "</span></div>" +
      "<div class='btn-row'>" + buttons.join("") + "</div>";
    document.getElementById("overlay").classList.add("show");
  } catch (err) { toast("Error: " + err.message); }
}

async function resolveOrder(id, action) {
  try {
    await api("/admin/api/orders/" + id + "/" + action, { method: "POST" });
    toast("Order #" + id + " updated (" + action + ")");
    closeModal();
    loadOrders();
  } catch (err) { toast("Error: " + err.message); }
}

async function banFromOrder(userId, orderId) {
  try {
    await api("/admin/api/users/" + userId + "/ban", { method: "POST", body: JSON.stringify({ reason: "Banned from order #" + orderId }) });
    toast("User " + userId + " banned");
    closeModal();
    loadBanned();
  } catch (err) { toast("Error: " + err.message); }
}

async function banUser() {
  const userId = document.getElementById("banUserId").value.trim();
  const reason = document.getElementById("banReason").value.trim();
  if (!userId) return toast("Enter a user ID first");
  try {
    await api("/admin/api/users/" + userId + "/ban", { method: "POST", body: JSON.stringify({ reason: reason || null }) });
    toast("User " + userId + " banned");
    document.getElementById("banUserId").value = "";
    document.getElementById("banReason").value = "";
    loadBanned();
  } catch (err) { toast("Error: " + err.message); }
}

async function unbanUser(userId) {
  try {
    await api("/admin/api/users/" + userId + "/unban", { method: "POST" });
    toast("User " + userId + " unbanned");
    loadBanned();
  } catch (err) { toast("Error: " + err.message); }
}

async function sendBroadcast() {
  const message = document.getElementById("broadcastMsg").value.trim();
  if (!message) return toast("Type a message first");
  if (!confirm("Send this message to ALL users?")) return;
  try {
    const { sent, failed } = await api("/admin/api/broadcast", { method: "POST", body: JSON.stringify({ message }) });
    toast("Sent to " + sent + " users" + (failed > 0 ? " (" + failed + " failed)" : ""));
    document.getElementById("broadcastMsg").value = "";
    loadBroadcastHistory();
  } catch (err) { toast("Error: " + err.message); }
}

function loadAll() { loadOrders(); loadBanned(); loadBroadcastHistory(); }
loadAll();
</script>
</body>
</html>`;

app.get("/admin", (req, res) => res.send(DASHBOARD_HTML));

app.get("/admin/api/orders", async (req, res) => {
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, status, payment_status, user_username, runner_username, total_price")
    .in("status", ["open", "matched", "in_progress"])
    .order("id", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ orders: orders || [] });
});

app.get("/admin/api/orders/:id", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  return res.json({ order });
});

app.post("/admin/api/orders/:id/complete", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    await supabase.from("orders").update({ status: "completed" }).eq("id", Number(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "force_complete", { orderId: order.id });
    if (order.runner_id) await bot.sendMessage(order.runner_id, `✅ Task #${order.id} was marked completed by an admin.\n\n📧 ${SUPPORT_EMAIL}`).catch(() => {});
    await bot.sendMessage(order.user_id, `✅ Task #${order.id} was marked completed by an admin.\n\n📧 ${SUPPORT_EMAIL}`).catch(() => {});
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/admin/api/orders/:id/reset", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    await supabase.from("orders").update({
      runner_id: null, runner_username: null, agreed_price: null,
      runner_payout: null, total_price: null, status: "open", payment_status: "pending"
    }).eq("id", Number(order.id));
    await supabase.from("offers").delete().eq("order_id", String(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "reset_to_open", { orderId: order.id });
    await bot.sendMessage(order.user_id, `🔄 Your request #${order.id} was reset by an admin and is open for new offers again.`).catch(() => {});
    if (order.runner_id) await bot.sendMessage(order.runner_id, `🔄 Task #${order.id} was unassigned by an admin.`).catch(() => {});
    await bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n\n📦 Request:\n${order.request_text}\n\n📍 Location:\n${order.delivery_location}`,
      { message_thread_id: GIGS_TOPIC_ID, reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${order.id}` }]] } }
    );
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/admin/api/orders/:id/refund", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    await supabase.from("orders").update({ status: "refunded", payment_status: "refunded" }).eq("id", Number(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "mark_refunded", { orderId: order.id });
    await bot.sendMessage(order.user_id, `💵 Your payment for task #${order.id} has been marked for refund. Contact ${SUPPORT_EMAIL} with questions.`).catch(() => {});
    if (order.runner_id) await bot.sendMessage(order.runner_id, `⚠️ Task #${order.id} was cancelled and refunded by an admin.`).catch(() => {});
    return res.json({ ok: true, note: "Records updated only — process the real refund in Flutterwave." });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/admin/api/orders/:id/void", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    await supabase.from("orders").update({ status: "voided" }).eq("id", Number(order.id));
    await supabase.from("offers").delete().eq("order_id", String(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "void_order", { orderId: order.id });
    await bot.sendMessage(order.user_id, `🗑 Your request #${order.id} was removed by an admin.\n\nContact ${SUPPORT_EMAIL} if you have questions.`).catch(() => {});
    if (order.runner_id) await bot.sendMessage(order.runner_id, `🗑 Task #${order.id} was removed by an admin.`).catch(() => {});
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/admin/api/users/banned", async (req, res) => {
  const { data: users, error } = await supabase.from("users").select("id, username, ban_reason").eq("banned", true);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ users: users || [] });
});

app.post("/admin/api/users/:id/ban", async (req, res) => {
  try {
    const targetId = req.params.id;
    const reason   = (req.body && req.body.reason) || null;
    await supabase.from("users").update({ banned: true, ban_reason: reason, banned_at: new Date().toISOString() }).eq("id", targetId);
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "ban_user", { targetUserId: targetId, note: reason });
    await bot.sendMessage(targetId, banMessage({ ban_reason: reason })).catch(() => {});
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/admin/api/users/:id/unban", async (req, res) => {
  try {
    const targetId = req.params.id;
    await supabase.from("users").update({ banned: false, ban_reason: null, banned_at: null }).eq("id", targetId);
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "unban_user", { targetUserId: targetId });
    await bot.sendMessage(targetId, "✅ Your Helply account has been reinstated. Send /start to continue.").catch(() => {});
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
// POST /admin/api/broadcast — inserts into broadcasts table, then sends
// to every user. Returns { sent, failed } counts.
// GET  /admin/api/broadcasts — returns recent broadcast history.

app.post("/admin/api/broadcast", async (req, res) => {
  try {
    const message = (req.body && req.body.message || "").trim();
    if (!message) return res.status(400).json({ error: "Message is required" });

    const { data: users, error: usersErr } = await supabase
      .from("users")
      .select("id")
      .eq("accepted_terms", true)
      .eq("banned", false);

    if (usersErr) return res.status(500).json({ error: usersErr.message });

    let sent = 0;
    let failed = 0;

    for (const user of (users || [])) {
      try {
        await bot.sendMessage(user.id, `📢 *Helply Update*\n\n${message}`, { parse_mode: "Markdown" });
        sent++;
      } catch (e) {
        console.log(`BROADCAST FAILED for ${user.id}:`, e.message);
        failed++;
      }
    }

    // Store in broadcasts table with recipient count
    await supabase.from("broadcasts").insert([{
      message,
      sent_count: sent
    }]);

    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "broadcast", { note: `Sent: ${sent}, Failed: ${failed}` });

    return res.json({ ok: true, sent, failed });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/admin/api/broadcasts", async (req, res) => {
  const { data: broadcasts, error } = await supabase
    .from("broadcasts")
    .select("id, message, sent_count, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ broadcasts: broadcasts || [] });
});

// ================= SERVER =================

app.listen(3000, () => {
  console.log("🌐 Server running on port 3000");
});
