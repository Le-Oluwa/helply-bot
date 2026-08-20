// Required env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, RUNNER_GROUP_ID,
// BASE_URL, FLW_WEBHOOK_SECRET, RUNNER_SIGNUP_FORM_URL

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const express = require("express");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Native Telegram command menu (the "/" icon next to the message box).
// Only user-facing commands go here — admin commands stay out of this
// list since it's visible to every user of the bot, not just admins.
bot.setMyCommands([
  { command: "start", description: "Get started / see the main menu" },
  { command: "help", description: "See what Helply can do" },
  { command: "becomehelper", description: "Sign up to earn as a Helper" },
  { command: "stats", description: "See your Helper earnings" },
  { command: "cancel", description: "Cancel whatever you're doing" }
]).catch(err => console.log("Could not set command menu:", err.message));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;
const GIGS_TOPIC_ID = 2;
const BASE_URL = process.env.BASE_URL;
const MIN_PRICE = 50;
const SUPPORT_EMAIL = "helply.cu@gmail.com";
const RUNNER_SIGNUP_FORM_URL = process.env.RUNNER_SIGNUP_FORM_URL || "https://forms.gle/P8Gb7zmVHQQEZ9JB7";

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

// Audit trail for every moderation/dispute action an admin takes.
async function logAdminAction(adminId, action, { orderId, targetUserId, note } = {}) {
  const { error } = await supabase.from("admin_actions").insert([{
    admin_id: adminId,
    action,
    order_id: orderId ? String(orderId) : null,
    target_user_id: targetUserId || null,
    note: note || null
  }]);
  if (error) console.log("ADMIN ACTION LOG ERROR:", error.message);
}

function banMessage(user) {
  return `🚫 Your Helply account has been suspended.${user?.ban_reason ? `\n\nReason: ${user.ban_reason}` : ""}\n\nContact ${SUPPORT_EMAIL} if you think this is a mistake.`;
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

function formatNaira(n) {
  return `₦${Number(n || 0).toLocaleString("en-NG")}`;
}

// ================= STATS / EARNINGS =================

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

// Pulls every completed task where this user was the runner, plus any
// currently in-progress (paid, not yet completed) tasks so runners can see
// money that's "on the way" as well as money already banked.
async function computeRunnerStats(userId) {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  const { data: completed, error: completedErr } = await supabase
    .from("orders")
    .select("runner_payout, created_at")
    .eq("runner_id", userId)
    .eq("status", "completed");

  if (completedErr) console.log("STATS COMPLETED ERROR:", completedErr.message);

  const { data: pending, error: pendingErr } = await supabase
    .from("orders")
    .select("runner_payout")
    .eq("runner_id", userId)
    .eq("status", "in_progress")
    .eq("payment_status", "paid");

  if (pendingErr) console.log("STATS PENDING ERROR:", pendingErr.message);

  const rows = completed || [];
  const pendingRows = pending || [];

  const totalTasks = rows.length;
  const totalEarned = rows.reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);

  const weekEarned = rows
    .filter(r => r.created_at && new Date(r.created_at) >= weekStart)
    .reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);

  const monthEarned = rows
    .filter(r => r.created_at && new Date(r.created_at) >= monthStart)
    .reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);

  const avgPerTask = totalTasks > 0 ? Math.round(totalEarned / totalTasks) : 0;

  const pendingCount = pendingRows.length;
  const pendingEarnings = pendingRows.reduce((sum, r) => sum + Number(r.runner_payout || 0), 0);

  return {
    totalTasks,
    totalEarned,
    weekEarned,
    monthEarned,
    avgPerTask,
    pendingCount,
    pendingEarnings
  };
}

function formatRunnerStats(stats) {
  let text = `📊 *Your Helper Stats*\n\n`;
  text += `✅ Tasks completed: *${stats.totalTasks}*\n`;
  text += `💰 Total earned: *${formatNaira(stats.totalEarned)}*\n`;
  text += `📈 Avg per task: *${formatNaira(stats.avgPerTask)}*\n\n`;
  text += `📅 This week: *${formatNaira(stats.weekEarned)}*\n`;
  text += `🗓️ This month: *${formatNaira(stats.monthEarned)}*\n`;

  if (stats.pendingCount > 0) {
    text += `\n⏳ Active: *${stats.pendingCount}* task(s) worth *${formatNaira(stats.pendingEarnings)}* once completed`;
  } else if (stats.totalTasks === 0) {
    text += `\nNo completed tasks yet — accept a request from the runner group to get started!`;
  }

  return text;
}

// ================= ADMIN ACCESS =================

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);
function isAdmin(userId) {
  return ADMIN_IDS.has(userId);
}

// ================= MAIN REPLY KEYBOARD =================
// Persistent buttons pinned under the message box (separate from the
// inline buttons attached to individual messages elsewhere in the bot).
// Tapping one just sends its label as plain text — it can't open a URL
// directly — so the message handler below intercepts these exact labels
// and routes them to the same logic as their /command equivalents.

const BTN_BECOME_HELPER = "🏃 Become a Helper";
const BTN_STATS = "📊 My Stats";
const BTN_HELP = "❓ Help";
const BTN_CANCEL = "❌ Cancel";

const mainReplyKeyboard = {
  reply_markup: {
    keyboard: [
      [BTN_BECOME_HELPER, BTN_STATS],
      [BTN_HELP, BTN_CANCEL]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// ================= START / CANCEL =================

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();
  const username = msg.from.username || "";

  let { data: user } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();

  if (!user) {
    await supabase.from("users").insert([{ id: userId, username, accepted_terms: false, banned: false }]);
    user = { id: userId, accepted_terms: false };
  }

  if (user.banned) {
    return bot.sendMessage(userId, banMessage(user));
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
  return bot.sendMessage(
    userId,
    "🚀 Welcome back to Helply\n\nSend your request, or use the buttons below anytime.",
    mainReplyKeyboard
  );
});

// Standalone command in case someone wants the signup link without
// re-reading the whole welcome message. Also triggered by the
// "🏃 Become a Helper" reply-keyboard button.
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
bot.onText(/\/becomehelper/, (msg) => sendBecomeHelperMessage(msg.from.id.toString()));

// Also triggered by the "❌ Cancel" reply-keyboard button.
async function handleCancelCommand(userId) {
  if (pendingState[userId]) {
    clearPendingState(userId);
    return bot.sendMessage(userId, "✅ Cancelled. Send a new request whenever you're ready.");
  }
  return bot.sendMessage(userId, "Nothing to cancel.");
}
bot.onText(/\/cancel/, (msg) => handleCancelCommand(msg.from.id.toString()));

// Also triggered by the "📊 My Stats" reply-keyboard button.
async function sendStatsMessage(userId) {
  const user = await getUser(userId);
  if (!user) {
    return bot.sendMessage(userId, "⚠️ Send /start first.");
  }

  try {
    const stats = await computeRunnerStats(userId);
    return bot.sendMessage(userId, formatRunnerStats(stats), { parse_mode: "Markdown" });
  } catch (err) {
    console.log("STATS ERROR:", err.message);
    return bot.sendMessage(userId, "❌ Couldn't load your stats right now. Try again shortly.");
  }
}
bot.onText(/\/stats/, (msg) => sendStatsMessage(msg.from.id.toString()));

// Also triggered by the "❓ Help" reply-keyboard button.
async function sendHelpMessage(userId) {
  let text = `🤖 *What Helply can do*

*Getting things done*
Just type what you need (e.g. "pick up my parcel from the gate") — I'll ask for the delivery location and post it to our Helpers.

*Buttons / Commands*
🏃 Become a Helper — Sign up to earn money completing tasks
📊 My Stats — See your Helper earnings
❌ Cancel — Cancel whatever you're currently doing
/start — Main menu
/help — This message

Need a hand? 📧 ${SUPPORT_EMAIL}`;

  if (isAdmin(userId)) {
    text += `\n\n*Admin commands*
/admin — Full admin command list
/activeorders — List open, matched, in-progress orders
/order <id> — View & resolve a specific order
/ban <userId> [reason]
/unban <userId>
/banned — List banned users`;
  }

  return bot.sendMessage(userId, text, { parse_mode: "Markdown" });
}
bot.onText(/\/help/, (msg) => sendHelpMessage(msg.from.id.toString()));

// ===== ADMIN: ORDERS & USERS =====

bot.onText(/^\/admin$/, async (msg) => {
  const userId = msg.from.id.toString();
  if (!isAdmin(userId)) return;

  const text = `🛠️ *Admin Commands*

*Orders*
/activeorders — list open, matched, and in-progress orders
/order <id> — view an order and resolve a dispute

*Users*
/ban <userId> [reason]
/unban <userId>
/banned — list currently banned users`;

  return bot.sendMessage(userId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/activeorders/, async (msg) => {
  const userId = msg.from.id.toString();
  if (!isAdmin(userId)) return;

  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, status, user_username, runner_username, total_price")
    .in("status", ["open", "matched", "in_progress"])
    .order("id", { ascending: false })
    .limit(25);

  if (error) {
    console.log("ACTIVEORDERS ERROR:", error.message);
    return bot.sendMessage(userId, "❌ Couldn't load orders right now.");
  }

  if (!orders || orders.length === 0) {
    return bot.sendMessage(userId, "✅ No active orders right now.");
  }

  const statusEmoji = { open: "🟡", matched: "🟠", in_progress: "🟢" };

  let text = `📋 *Active Orders* (${orders.length})\n\n`;
  orders.forEach(o => {
    text += `${statusEmoji[o.status] || "⚪"} #${o.id} — ${o.status} — @${o.user_username || "?"}`;
    text += o.runner_username ? ` → @${o.runner_username}` : ` → unassigned`;
    if (o.total_price) text += ` — ${formatNaira(o.total_price)}`;
    text += `\n`;
  });
  text += `\nUse /order <id> for details or to resolve.`;

  return bot.sendMessage(userId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/order (\d+)/, async (msg, match) => {
  const userId = msg.from.id.toString();
  if (!isAdmin(userId)) return;

  const order = await getOrder(match[1]);
  if (!order) return bot.sendMessage(userId, "❌ Order not found.");

  const text = `📦 *Order #${order.id}*

Status: *${order.status}* | Payment: *${order.payment_status}*

👤 Requester: @${order.user_username || "unknown"} (\`${order.user_id}\`)
🏃 Runner: ${order.runner_id ? `@${order.runner_username || "unknown"} (\`${order.runner_id}\`)` : "unassigned"}

📦 Request: ${order.request_text || "—"}
📍 Location: ${order.delivery_location || "—"}

💰 Agreed price: ${formatNaira(order.agreed_price)}
💵 Runner payout: ${formatNaira(order.runner_payout)}
💳 Total charged: ${formatNaira(order.total_price)}`;

  const buttons = [];
  if (order.status !== "completed") {
    buttons.push([{ text: "✅ Force complete", callback_data: `admin_complete_${order.id}` }]);
  }
  if (order.status === "matched" || order.status === "in_progress") {
    buttons.push([{ text: "🔄 Reset to open", callback_data: `admin_reset_${order.id}` }]);
  }
  if (order.payment_status === "paid") {
    buttons.push([{ text: "💵 Mark refunded", callback_data: `admin_refund_${order.id}` }]);
  }
  buttons.push([{ text: "🗑 Void order", callback_data: `admin_void_${order.id}` }]);

  const userButtons = [{ text: "🚫 Ban requester", callback_data: `adminban_${order.user_id}_${order.id}` }];
  if (order.runner_id) userButtons.push({ text: "🚫 Ban runner", callback_data: `adminban_${order.runner_id}_${order.id}` });
  buttons.push(userButtons);

  return bot.sendMessage(userId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
});

bot.onText(/\/ban (\d+)(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from.id.toString();
  if (!isAdmin(userId)) return;

  const targetId = match[1];
  const reason = match[2] || null;

  await supabase.from("users").update({
    banned: true,
    ban_reason: reason,
    banned_at: new Date().toISOString()
  }).eq("id", targetId);

  await logAdminAction(userId, "ban_user", { targetUserId: targetId, note: reason });

  await bot.sendMessage(targetId, banMessage({ ban_reason: reason })).catch(() => {});
  return bot.sendMessage(userId, `✅ User \`${targetId}\` banned${reason ? ` — ${reason}` : ""}.`, { parse_mode: "Markdown" });
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  const userId = msg.from.id.toString();
  if (!isAdmin(userId)) return;

  const targetId = match[1];
  await supabase.from("users").update({ banned: false, ban_reason: null, banned_at: null }).eq("id", targetId);
  await logAdminAction(userId, "unban_user", { targetUserId: targetId });

  await bot.sendMessage(targetId, "✅ Your Helply account has been reinstated. Send /start to continue.").catch(() => {});
  return bot.sendMessage(userId, `✅ User \`${targetId}\` unbanned.`, { parse_mode: "Markdown" });
});

bot.onText(/\/banned/, async (msg) => {
  const userId = msg.from.id.toString();
  if (!isAdmin(userId)) return;

  const { data: users } = await supabase.from("users").select("id, username, ban_reason").eq("banned", true);
  if (!users || users.length === 0) return bot.sendMessage(userId, "✅ No banned users.");

  let text = `🚫 *Banned Users* (${users.length})\n\n`;
  users.forEach(u => {
    text += `\`${u.id}\` — @${u.username || "unknown"}${u.ban_reason ? ` — ${u.ban_reason}` : ""}\n`;
  });

  return bot.sendMessage(userId, text, { parse_mode: "Markdown" });
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

  if (currentUser.banned) {
    return bot.sendMessage(userId, banMessage(currentUser));
  }

  if (!currentUser.accepted_terms) {
    return bot.sendMessage(userId, "⚠️ Please accept terms using /start");
  }

  // ===== REPLY-KEYBOARD BUTTON TAPS =====
  // These fire regardless of what the user is mid-way through, so someone
  // stuck in a weird state can always tap their way back out.
  if (text === BTN_BECOME_HELPER) return sendBecomeHelperMessage(userId);
  if (text === BTN_STATS) return sendStatsMessage(userId);
  if (text === BTN_HELP) return sendHelpMessage(userId);
  if (text === BTN_CANCEL) return handleCancelCommand(userId);

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
    // BAN GATE — a banned user can't do anything else with the bot.
    if (!isAdmin(userId)) {
      const requester = await getUser(userId);
      if (requester?.banned) {
        return denyCallback(q, "🚫 Your account has been suspended.");
      }
    }

    // ===== ADMIN: ORDER RESOLUTION =====

    if (data.startsWith("admin_complete_")) {
      if (!isAdmin(userId)) return denyCallback(q);
      const orderId = data.split("_")[2];
      const order = await getOrder(orderId);
      if (!order) return denyCallback(q, "❌ Order not found");

      await supabase.from("orders").update({ status: "completed" }).eq("id", Number(orderId));
      await logAdminAction(userId, "force_complete", { orderId });

      if (order.runner_id) {
        await bot.sendMessage(order.runner_id, `✅ Task #${order.id} was marked completed by an admin.\n\n📧 ${SUPPORT_EMAIL}`).catch(() => {});
      }
      await bot.sendMessage(order.user_id, `✅ Task #${order.id} was marked completed by an admin.\n\n📧 ${SUPPORT_EMAIL}`).catch(() => {});

      await bot.sendMessage(userId, `✅ Order #${order.id} marked completed.`);
      return bot.answerCallbackQuery(q.id);
    }

    if (data.startsWith("admin_reset_")) {
      if (!isAdmin(userId)) return denyCallback(q);
      const orderId = data.split("_")[2];
      const order = await getOrder(orderId);
      if (!order) return denyCallback(q, "❌ Order not found");

      await supabase.from("orders").update({
        runner_id: null,
        runner_username: null,
        agreed_price: null,
        runner_payout: null,
        total_price: null,
        status: "open",
        payment_status: "pending"
      }).eq("id", Number(orderId));
      await supabase.from("offers").delete().eq("order_id", String(orderId));
      await logAdminAction(userId, "reset_to_open", { orderId });

      await bot.sendMessage(order.user_id, `🔄 Your request #${order.id} was reset by an admin and is open for new offers again.`).catch(() => {});
      if (order.runner_id) {
        await bot.sendMessage(order.runner_id, `🔄 Task #${order.id} was unassigned by an admin.`).catch(() => {});
      }
      await bot.sendMessage(
        RUNNER_GROUP_ID,
        `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n📌 ${order.delivery_location}`,
        {
          message_thread_id: GIGS_TOPIC_ID,
          reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${order.id}` }]] }
        }
      );

      await bot.sendMessage(userId, `✅ Order #${order.id} reset to open.`);
      return bot.answerCallbackQuery(q.id);
    }

    if (data.startsWith("admin_refund_")) {
      if (!isAdmin(userId)) return denyCallback(q);
      const orderId = data.split("_")[2];
      const order = await getOrder(orderId);
      if (!order) return denyCallback(q, "❌ Order not found");

      await supabase.from("orders").update({ status: "refunded", payment_status: "refunded" }).eq("id", Number(orderId));
      await logAdminAction(userId, "mark_refunded", { orderId });

      await bot.sendMessage(order.user_id, `💵 Your payment for task #${order.id} has been marked for refund by an admin. Reach out to ${SUPPORT_EMAIL} with any questions.`).catch(() => {});
      if (order.runner_id) {
        await bot.sendMessage(order.runner_id, `⚠️ Task #${order.id} was cancelled and refunded by an admin.`).catch(() => {});
      }

      await bot.sendMessage(
        userId,
        `⚠️ Order #${order.id} marked refunded in Helply's records.\n\n*This does not trigger an actual Flutterwave refund* — process that manually in your Flutterwave dashboard.`,
        { parse_mode: "Markdown" }
      );
      return bot.answerCallbackQuery(q.id);
    }

    if (data.startsWith("admin_void_")) {
      if (!isAdmin(userId)) return denyCallback(q);
      const orderId = data.split("_")[2];
      const order = await getOrder(orderId);
      if (!order) return denyCallback(q, "❌ Order not found");

      await supabase.from("orders").update({ status: "voided" }).eq("id", Number(orderId));
      await supabase.from("offers").delete().eq("order_id", String(orderId));
      await logAdminAction(userId, "void_order", { orderId });

      await bot.sendMessage(order.user_id, `🗑 Your request #${order.id} was removed by an admin.\n\nContact ${SUPPORT_EMAIL} if you have questions.`).catch(() => {});
      if (order.runner_id) {
        await bot.sendMessage(order.runner_id, `🗑 Task #${order.id} was removed by an admin.`).catch(() => {});
      }

      await bot.sendMessage(userId, `✅ Order #${order.id} voided.`);
      return bot.answerCallbackQuery(q.id);
    }

    if (data.startsWith("adminban_")) {
      if (!isAdmin(userId)) return denyCallback(q);
      const parts = data.split("_"); // adminban_<targetId>_<orderId>
      const targetId = parts[1];
      const orderId = parts[2];

      await supabase.from("users").update({
        banned: true,
        ban_reason: `Banned from order #${orderId}`,
        banned_at: new Date().toISOString()
      }).eq("id", targetId);

      await logAdminAction(userId, "ban_user", { orderId, targetUserId: targetId });

      await bot.sendMessage(targetId, banMessage({ ban_reason: `Banned from order #${orderId}` })).catch(() => {});
      await bot.sendMessage(userId, `✅ User \`${targetId}\` banned.`, { parse_mode: "Markdown" });
      return bot.answerCallbackQuery(q.id);
    }

    // ACCEPT / DECLINE TERMS
    if (data === "accept_terms") {
      await supabase.from("users").update({ accepted_terms: true }).eq("id", userId);
      await bot.sendMessage(userId, "🎉 You're in! Send your request, or use the buttons below anytime.", mainReplyKeyboard);
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
