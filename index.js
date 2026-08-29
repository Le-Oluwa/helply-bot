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

// Native Telegram command menu (the "/" icon next to the message box).
// Only user-facing commands go here — admin commands stay out of this
// list since it's visible to every user of the bot, not just admins.
bot.setMyCommands([
  { command: "start", description: "Get started / see the main menu" },
  { command: "help", description: "See what Helply can do" },
  { command: "services", description: "Browse Food Runs, Laundry, Printing, Errands" },
  { command: "becomehelper", description: "Sign up to earn as a Helper" },
  { command: "stats", description: "See your Helper earnings" }
]).catch(err => console.log("Could not set command menu:", err.message));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;
const GIGS_TOPIC_ID = 2;
const BASE_URL = process.env.BASE_URL;
const MIN_PRICE = 50;
const SUPPORT_EMAIL = "helply.cu@gmail.com";
const RUNNER_SIGNUP_FORM_URL = process.env.RUNNER_SIGNUP_FORM_URL || "https://forms.gle/P8Gb7zmVHQQEZ9JB7";

// Printing category: the printer is contacted directly via their own
// Telegram chat, and the printing cost is auto-calculated (not negotiated)
// so it can be added on top of the runner's negotiated delivery fee.
const PRINTER_CHAT_ID = process.env.PRINTER_CHAT_ID;
const PRICE_PER_PAGE_BW = Number(process.env.PRICE_PER_PAGE_BW || 20);
const PRICE_PER_PAGE_COLOR = Number(process.env.PRICE_PER_PAGE_COLOR || 100);
const BINDING_FEE = Number(process.env.BINDING_FEE || 200);

function computePrintCost(pages, color, binding) {
  const perPage = color === "color" ? PRICE_PER_PAGE_COLOR : PRICE_PER_PAGE_BW;
  let cost = perPage * Number(pages || 0);
  if (binding) cost += BINDING_FEE;
  return cost;
}

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

// A user is only "busy" (blocked from taking/posting a new task) once a
// task has actually been paid for and isn't completed yet. A "matched"
// order (accepted but unpaid) does NOT block — either side can still
// cancel it and move on freely before money changes hands.
async function isBusy(userId) {
  const { data } = await supabase
    .from("orders")
    .select("id, status")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .in("status", ["in_progress"]);
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

// Called once the user uploads the document/photo — the last step of the
// printing flow. Creates the order, posts the pickup job to the runner
// group (with delivery location), and forwards the actual file straight
// to the printer's Telegram chat (without the delivery location, since
// the printer doesn't need it).
async function finalizePrintingOrder(msg, userId, printData) {
  let taskId;
  try {
    taskId = await generateUniqueTaskId();
  } catch (e) {
    clearPendingState(userId);
    return bot.sendMessage(userId, "❌ Something went wrong creating your print request. Please try again.");
  }

  const printCost = computePrintCost(printData.pages, printData.color, printData.binding);
  const colorLabel = printData.color === "color" ? "Color" : "Black & White";

  const requestText = `[Printing] ${printData.pages} page(s), ${colorLabel}, ${printData.paper}` +
    `${printData.binding ? ", Binding" : ""}${printData.note ? ` — Note: ${printData.note}` : ""}`;

  // Store the file reference now — it's sent to the printer later, only
  // once the user has actually paid (see the Flutterwave webhook).
  const printFileId = msg.document ? msg.document.file_id : msg.photo[msg.photo.length - 1].file_id;
  const printFileType = msg.document ? "document" : "photo";

  const { error } = await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId,
    user_username: msg.from.username || "",
    request_text: requestText,
    delivery_location: printData.location,
    status: "open",
    payment_status: "pending",
    category: "Printing",
    print_color: printData.color,
    print_paper: printData.paper,
    print_pages: printData.pages,
    print_binding: !!printData.binding,
    print_note: printData.note || null,
    print_cost: printCost,
    print_file_id: printFileId,
    print_file_type: printFileType
  }]);

  clearPendingState(userId);

  if (error) {
    console.log("PRINT ORDER INSERT ERROR:", error.message);
    return bot.sendMessage(userId, "❌ Something went wrong creating your print request. Please try again.");
  }

  await bot.sendMessage(
    userId,
    `✅ Print request sent!\n\n🆔 Request ID: ${taskId}\n\n📦 ${requestText}\n\n📍 Delivery:\n${printData.location}\n\n🖨️ Printing cost: ${formatNaira(printCost)} (added to your total once a Helper is matched)\n\n⏳ Please wait while we match you with a Helper...`,
    { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Request", callback_data: `cancelreq_${taskId}` }]] } }
  );

  await bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 PRINTING PICKUP NEEDED\n\n🆔 ${taskId}\n\n📦 ${requestText}\n\n📍 Delivery:\n${printData.location}`,
    {
      message_thread_id: GIGS_TOPIC_ID,
      reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${taskId}` }]] }
    }
  );
}

async function denyCallback(q, text = "❌ You can't do that") {
  return bot.answerCallbackQuery(q.id, { text, show_alert: true });
}

// Generalized button-based price picker. Used for all three price-entry
// points (new offer, user counter, runner counter) so nobody ever has to
// type a number — "kind" + "refId" together identify what happens on
// submit: kind "new" -> refId is a taskId (creates a fresh offer),
// kind "ucounter"/"rcounter" -> refId is an offerId (updates that offer).
const DEFAULT_OFFER_START = 200;

async function sendPriceAdjuster(chatId, price, kind, refId, editMessageId) {
  const text = `💰 Set the offer amount: ₦${price}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "-1000", callback_data: `padj_${kind}_${refId}_${price}_-1000` },
        { text: "-500", callback_data: `padj_${kind}_${refId}_${price}_-500` },
        { text: "-50", callback_data: `padj_${kind}_${refId}_${price}_-50` }
      ],
      [
        { text: "+50", callback_data: `padj_${kind}_${refId}_${price}_50` },
        { text: "+500", callback_data: `padj_${kind}_${refId}_${price}_500` },
        { text: "+1000", callback_data: `padj_${kind}_${refId}_${price}_1000` }
      ],
      [{ text: "✅ Submit", callback_data: `psub_${kind}_${refId}_${price}` }]
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

// ================= MAIN REPLY KEYBOARD =================
// Persistent buttons pinned under the message box (separate from the
// inline buttons attached to individual messages elsewhere in the bot).
// Tapping one just sends its label as plain text — it can't open a URL
// directly — so the message handler below intercepts these exact labels
// and routes them to the same logic as their /command equivalents.

const BTN_SERVICES = "📋 Our Services";
const BTN_BECOME_HELPER = "🏃 Become a Helper";
const BTN_STATS = "📊 My Stats";
const BTN_HELP = "❓ Help";

const mainReplyKeyboard = {
  reply_markup: {
    keyboard: [
      [BTN_SERVICES],
      [BTN_BECOME_HELPER, BTN_STATS],
      [BTN_HELP]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Service categories shown on the "📋 Our Services" menu. Each maps a
// callback_data suffix to a friendly label. "other" is a free-form escape
// hatch so nobody's boxed into these four options.
const SERVICE_CATEGORIES = {
  food: "Food Runs",
  laundry: "Laundry",
  printing: "Printing",
  errand: "Errands"
};

function servicesMenuMessage() {
  return {
    text: "📋 What do you need help with today?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🍔 Food Runs", callback_data: "service_food" }],
        [{ text: "🧺 Laundry", callback_data: "service_laundry" }],
        [{ text: "🖨️ Printing", callback_data: "service_printing" }],
        [{ text: "🏃 Errands", callback_data: "service_errand" }],
        [{ text: "✏️ Something else", callback_data: "service_other" }]
      ]
    }
  };
}

async function sendServicesMenu(userId) {
  const { text, reply_markup } = servicesMenuMessage();
  return bot.sendMessage(userId, text, { reply_markup });
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

// Also triggered by the "📋 Our Services" reply-keyboard button.
bot.onText(/\/services/, (msg) => sendServicesMenu(msg.from.id.toString()));

// Also triggered by the "❓ Help" reply-keyboard button.
async function sendHelpMessage(userId) {
  let text = `🤖 *What Helply can do*

*Getting things done*
Tap 📋 Our Services to pick a category (Food Runs, Laundry, Printing, Errands), or just type what you need (e.g. "pick up my parcel from the gate") — I'll ask for the delivery location and post it to our Helpers.

*Buttons / Commands*
📋 Our Services — Browse what Helply can help with
🏃 Become a Helper — Sign up to earn money completing tasks
📊 My Stats — See your Helper earnings
/start — Main menu
/help — This message

Need a hand? 📧 ${SUPPORT_EMAIL}`;

  return bot.sendMessage(userId, text, { parse_mode: "Markdown" });
}
bot.onText(/\/help/, (msg) => sendHelpMessage(msg.from.id.toString()));

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id.toString();

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

  const state = pendingState[userId];

  // ===== PRINTING: DOCUMENT/PHOTO UPLOAD =====
  // These messages have no msg.text at all, so they must be caught here,
  // before the text-only bail-out below would otherwise ignore them.
  if (state?.mode === "print_upload_wait") {
    if (msg.document || msg.photo) {
      return finalizePrintingOrder(msg, userId, state.printData);
    }
    if (msg.text) {
      return bot.sendMessage(userId, "📎 Please send the document as a file or photo (not text).");
    }
    return;
  }

  if (!msg.text || msg.text.startsWith("/")) return;

  const text = msg.text.trim();

  // ===== REPLY-KEYBOARD BUTTON TAPS =====
  // These fire regardless of what the user is mid-way through, so someone
  // stuck in a weird state can always tap their way back out.
  if (text === BTN_SERVICES) return sendServicesMenu(userId);
  if (text === BTN_BECOME_HELPER) return sendBecomeHelperMessage(userId);
  if (text === BTN_STATS) return sendStatsMessage(userId);
  if (text === BTN_HELP) return sendHelpMessage(userId);

  // ===== PRINTING: PAPER TYPE =====
  if (state?.mode === "print_paper") {
    const printData = { ...state.printData, paper: text };
    pendingState[userId] = { mode: "print_pages", printData };
    return bot.sendMessage(userId, "📄 How many pages?");
  }

  // ===== PRINTING: PAGE COUNT =====
  if (state?.mode === "print_pages") {
    const pages = parseInt(text, 10);
    if (isNaN(pages) || pages <= 0) {
      return bot.sendMessage(userId, "❌ Enter a valid number of pages (e.g. 10).");
    }
    const printData = { ...state.printData, pages };
    pendingState[userId] = { mode: "print_binding_wait", printData };
    return bot.sendMessage(userId, "📎 Does it need binding?", {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Yes", callback_data: "printbinding_yes" },
          { text: "❌ No", callback_data: "printbinding_no" }
        ]]
      }
    });
  }

  // ===== PRINTING: SPECIAL NOTE =====
  if (state?.mode === "print_note") {
    const note = text.toLowerCase() === "none" ? null : text;
    const printData = { ...state.printData, note };
    pendingState[userId] = { mode: "print_delivery_location", printData };
    return bot.sendMessage(userId, "📍 Enter your delivery location:");
  }

  // ===== PRINTING: DELIVERY LOCATION =====
  if (state?.mode === "print_delivery_location") {
    const printData = { ...state.printData, location: text };
    pendingState[userId] = { mode: "print_upload_wait", printData };
    return bot.sendMessage(userId, "📎 Now send the document you'd like printed — as a file or a photo.");
  }

  // ===== USER TYPING DETAILS AFTER PICKING A SERVICE CATEGORY =====
  // Funnels straight into the existing "location" step below — no new
  // order-creation logic, just a friendlier on-ramp into the same flow.
  if (state?.mode === "category_detail") {
    const requestText = state.category ? `[${state.category}] ${text}` : text;
    pendingState[userId] = { mode: "location", request: requestText };
    return bot.sendMessage(userId, "📍 Enter your delivery location:");
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
      `✅ Request sent successfully!\n\n🆔 Request ID: ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}\n\n⏳ Please wait while we match you with a Helper...`,
      { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Request", callback_data: `cancelreq_${taskId}` }]] } }
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
    const requester = await getUser(userId);
    if (requester?.banned) {
      return denyCallback(q, "🚫 Your account has been suspended.");
    }

    // SERVICES MENU — pick a category, then ask for the specifics before
    // funneling into the normal location-asking flow.
    if (data.startsWith("service_")) {
      const key = data.split("_")[1];

      if (key === "other") {
        pendingState[userId] = { mode: "category_detail", category: null };
        await bot.sendMessage(userId, "📝 Tell me what you need:");
        return bot.answerCallbackQuery(q.id);
      }

      if (key === "printing") {
        pendingState[userId] = { mode: "print_awaiting_color", printData: {} };
        await bot.sendMessage(userId, "🖨️ Printing request\n\nFirst, black & white or color?", {
          reply_markup: {
            inline_keyboard: [[
              { text: "⚫ Black & White", callback_data: "printcolor_bw" },
              { text: "🎨 Color", callback_data: "printcolor_color" }
            ]]
          }
        });
        return bot.answerCallbackQuery(q.id);
      }

      const category = SERVICE_CATEGORIES[key];
      if (!category) return denyCallback(q, "❌ Unknown service category");

      pendingState[userId] = { mode: "category_detail", category };
      await bot.sendMessage(userId, `📝 Tell me what you need for ${category} (e.g. "pick up rice from Mama's kitchen"):`);
      return bot.answerCallbackQuery(q.id);
    }

    // PRINTING: COLOR CHOICE
    if (data.startsWith("printcolor_")) {
      const color = data.split("_")[1]; // "bw" or "color"
      const printData = { ...(pendingState[userId]?.printData || {}), color };
      pendingState[userId] = { mode: "print_paper", printData };
      await bot.sendMessage(userId, "📄 What type of paper? (e.g. A4, Foolscap, Glossy)");
      return bot.answerCallbackQuery(q.id);
    }

    // PRINTING: BINDING CHOICE
    if (data.startsWith("printbinding_")) {
      const choice = data.split("_")[1]; // "yes" or "no"
      const printData = { ...(pendingState[userId]?.printData || {}), binding: choice === "yes" };
      pendingState[userId] = { mode: "print_note", printData };
      await bot.sendMessage(userId, "📝 Any special note? (or type \"none\")");
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

      await sendPriceAdjuster(userId, DEFAULT_OFFER_START, "new", taskId);
      return bot.answerCallbackQuery(q.id);
    }

    // ADJUST PRICE (shared by new offers, user counters, runner counters)
    if (data.startsWith("padj_")) {
      const [, kind, refId, currentPriceStr, changeStr] = data.split("_");
      let newPrice = Number(currentPriceStr) + Number(changeStr);
      if (newPrice < MIN_PRICE) newPrice = MIN_PRICE;

      await sendPriceAdjuster(q.message.chat.id, newPrice, kind, refId, q.message.message_id);
      return bot.answerCallbackQuery(q.id);
    }

    // SUBMIT PRICE (shared by new offers, user counters, runner counters)
    if (data.startsWith("psub_")) {
      const [, kind, refId, priceStr] = data.split("_");
      const price = Number(priceStr);

      if (kind === "new") {
        const taskId = refId;
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
          current_price: price
        }]);

        const { data: offers } = await supabase.from("offers").select("*").eq("order_id", String(taskId));
        const buttons = offers.map(o => [{ text: `${o.runner_name} - ₦${o.current_price}`, callback_data: `view_${o.id}` }]);
        buttons.push([{ text: "❌ Cancel Request", callback_data: `cancelreq_${taskId}` }]);

        await bot.sendMessage(order.user_id, "💰 Offers:", { reply_markup: { inline_keyboard: buttons } });
        await bot.sendMessage(
          userId,
          `⏳ Offer submitted successfully\n\n💰 Your Offer: ₦${price}\n\nWaiting for the user to accept, counter, or reject your offer.`
        );

        return bot.answerCallbackQuery(q.id);
      }

      if (kind === "ucounter") {
        const offerId = refId;
        const offer = await getOffer(offerId);
        if (!offer) return denyCallback(q, "❌ Offer not found");
        if (offer.user_id !== userId) return denyCallback(q);

        await supabase.from("offers").update({ current_price: price }).eq("id", offerId);

        await bot.sendMessage(
          offer.runner_id,
          `💬 User countered your offer\n\n💰 New price: ₦${price}`,
          offerButtons(offerId, true)
        );
        return bot.answerCallbackQuery(q.id);
      }

      if (kind === "rcounter") {
        const offerId = refId;
        const offer = await getOffer(offerId);
        if (!offer) return denyCallback(q, "❌ Offer not found");
        if (offer.runner_id !== userId) return denyCallback(q);

        await supabase.from("offers").update({ current_price: price }).eq("id", offerId);

        await bot.sendMessage(
          offer.user_id,
          `💬 Runner updated the offer\n\n💰 New price: ₦${price}`,
          offerButtons(offerId, false)
        );
        return bot.answerCallbackQuery(q.id);
      }

      return denyCallback(q, "❌ Unknown price action");
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

      await sendPriceAdjuster(userId, Number(o.current_price), "ucounter", offerId);
      return bot.answerCallbackQuery(q.id);
    }

    // RUNNER COUNTERS BACK
    if (data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[2];
      const o = await getOffer(offerId);
      if (!o) return denyCallback(q, "❌ Offer not found");
      if (o.runner_id !== userId) return denyCallback(q);

      await sendPriceAdjuster(userId, Number(o.current_price), "rcounter", offerId);
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
      const printCost = Number(order.print_cost || 0);
      const userPrice = Math.round(runnerFee * 1.3) + printCost;

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
      const priceBreakdown = printCost > 0 ? ` (includes ${formatNaira(printCost)} printing cost)` : "";

      await bot.sendMessage(
        o.runner_id,
        "📦 Task assigned\n\n⏳ Waiting for user payment...",
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Task", callback_data: `cancel_${o.order_id}` }]] } }
      );
      await bot.sendMessage(
        o.user_id,
        `💳 Pay ₦${userPrice}${priceBreakdown}\n\n${link}`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Task", callback_data: `cancel_${o.order_id}` }]] } }
      );

      return bot.answerCallbackQuery(q.id);
    }

    // CANCEL AN OPEN REQUEST (before any offer is accepted)
    if (data.startsWith("cancelreq_")) {
      const orderId = data.split("_")[1];
      const order = await getOrder(orderId);
      if (!order) return denyCallback(q, "❌ Request not found");
      if (order.user_id !== userId) return denyCallback(q);

      if (order.status !== "open") {
        return denyCallback(q, "❌ This request already has a Helper assigned — use the Cancel Task button on that message instead.");
      }

      const { data: pendingOffers } = await supabase.from("offers").select("*").eq("order_id", String(orderId));
      await supabase.from("offers").delete().eq("order_id", String(orderId));
      await supabase.from("orders").update({ status: "cancelled" }).eq("id", Number(orderId));

      clearPendingState(userId);

      for (const o of (pendingOffers || [])) {
        await bot.sendMessage(o.runner_id, `❌ The requester cancelled request #${orderId}. Your offer is no longer needed.`).catch(() => {});
      }

      await bot.sendMessage(userId, `✅ Request #${orderId} cancelled.`);
      return bot.answerCallbackQuery(q.id);
    }

    // CANCEL TASK (matched, unpaid)
    if (data.startsWith("cancel_")) {
      const id = data.split("_")[1];
      const order = await getOrder(id);
      if (!order) return denyCallback(q, "❌ Order not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);

      if (order.payment_status === "paid") {
        return denyCallback(q, "❌ Cannot cancel after payment");
      }

      const cancellerIsRunner = order.runner_id === userId;

      await supabase.from("offers").delete().eq("order_id", String(id));

      if (cancellerIsRunner) {
        // Runner backed out — the requester's request deserves another shot,
        // so reset to open and repost for other Helpers to pick up.
        await supabase.from("orders").update({
          runner_id: null,
          runner_username: null,
          agreed_price: null,
          runner_payout: null,
          total_price: null,
          status: "open",
          payment_status: "pending"
        }).eq("id", Number(id));

        await bot.sendMessage(
          RUNNER_GROUP_ID,
          `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n📌 ${order.delivery_location}`,
          {
            message_thread_id: GIGS_TOPIC_ID,
            reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${order.id}` }]] }
          }
        );

        await bot.sendMessage(order.user_id, "⚠️ Your Helper cancelled the task.\n\nYour request has been reposted.");
        await bot.sendMessage(order.runner_id, "❌ You cancelled the task.");
      } else {
        // Requester cancelled — they don't want this fulfilled at all,
        // so void it entirely instead of reposting.
        await supabase.from("orders").update({ status: "cancelled" }).eq("id", Number(id));

        await bot.sendMessage(order.user_id, "✅ You cancelled the task.");
        if (order.runner_id) {
          await bot.sendMessage(order.runner_id, "❌ The requester cancelled this task.").catch(() => {});
        }
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
        "💰 Payment received!\n\n📦 Task is now active.\n\n💬 You can now chat with the user — just type any message here and it'll be sent to them.",
        { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
      );
      await bot.sendMessage(
        order.user_id,
        "✅ Payment confirmed!\n\n🤝 You can now chat with your Helper — just type any message here and it'll be sent to them.",
        { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
      );

      // Printing orders: now that payment is confirmed, forward the actual
      // document/photo to the printer — never before this point. The
      // delivery location is deliberately left out (that went to the
      // runner group instead, not the printer).
      if (order.category === "Printing" && order.print_file_id) {
        if (!PRINTER_CHAT_ID) {
          console.log("PRINTER_CHAT_ID not set — skipped printer notification for order", orderId);
        } else {
          const colorLabel = order.print_color === "color" ? "Color" : "Black & White";
          const printerCaption = `🖨️ Paid print job #${orderId}\n\n${order.print_pages} page(s)\n${colorLabel}\nPaper: ${order.print_paper}\nBinding: ${order.print_binding ? "Yes" : "No"}${order.print_note ? `\nNote: ${order.print_note}` : ""}`;

          try {
            if (order.print_file_type === "document") {
              await bot.sendDocument(PRINTER_CHAT_ID, order.print_file_id, { caption: printerCaption });
            } else {
              await bot.sendPhoto(PRINTER_CHAT_ID, order.print_file_id, { caption: printerCaption });
            }
          } catch (err) {
            console.log("PRINTER NOTIFY ERROR:", err.message);
          }
        }
      }

      console.log("✅ WEBHOOK ORDER UPDATED:", orderId);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log("❌ WEBHOOK ERROR:", err.message);
    return res.sendStatus(500);
  }
});

// ================= ADMIN DASHBOARD =================

const DASHBOARD_USER = process.env.ADMIN_DASHBOARD_USER || "admin";
const DASHBOARD_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD;

// Simple HTTP Basic Auth gate for every /admin route. If the password env
// var isn't set, the dashboard refuses to serve anything rather than
// silently running unprotected.
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
          --yellow:#f5c542; --orange:#f59e42; --green:#4ade80; --red:#f87171; --blue:#60a5fa; }
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
  .badge.open { background:rgba(245,197,66,0.15); color:var(--yellow); }
  .badge.matched { background:rgba(245,158,66,0.15); color:var(--orange); }
  .badge.in_progress { background:rgba(74,222,128,0.15); color:var(--green); }
  .badge.completed { background:rgba(96,165,250,0.15); color:var(--blue); }
  .badge.voided, .badge.refunded { background:rgba(248,113,113,0.15); color:var(--red); }
  button { font:inherit; cursor:pointer; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:600; }
  .btn-primary { background:var(--blue); color:#0f1115; }
  .btn-warn { background:var(--orange); color:#0f1115; }
  .btn-danger { background:var(--red); color:#0f1115; }
  .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text); }
  .btn-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .empty { color:var(--muted); font-size:13px; padding:16px; text-align:center; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); display:none; align-items:center; justify-content:center; padding:20px; }
  .overlay.show { display:flex; }
  .modal { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px; max-width:480px; width:100%; max-height:85vh; overflow-y:auto; }
  .modal h3 { margin-top:0; }
  .modal .row { display:flex; justify-content:space-between; font-size:13px; padding:6px 0; border-bottom:1px solid var(--border); }
  .modal .label { color:var(--muted); }
  .close-x { float:right; background:none; color:var(--muted); padding:4px 8px; }
  input[type=text] { width:100%; padding:8px 10px; background:#0f1115; border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; margin-bottom:8px; }
  .ban-form { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .ban-form input { flex:1; min-width:140px; margin-bottom:0; }
  .toast { position:fixed; bottom:20px; right:20px; background:var(--card); border:1px solid var(--border); padding:12px 16px; border-radius:8px; font-size:13px; display:none; }
  .toast.show { display:block; }
  a { color:var(--blue); }
</style>
</head>
<body>

<header>
  <h1>🛠️ Helply Admin</h1>
  <button class="btn-ghost" onclick="loadAll()">Refresh</button>
</header>

<main>
  <section>
    <h2>Active Orders</h2>
    <div id="orders"></div>
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
  setTimeout(() => el.classList.remove("show"), 3000);
}

function naira(n) { return "₦" + Number(n || 0).toLocaleString("en-NG"); }

function closeModal() { document.getElementById("overlay").classList.remove("show"); }

async function loadOrders() {
  const container = document.getElementById("orders");
  container.innerHTML = "Loading...";
  try {
    const { orders } = await api("/admin/api/orders");
    if (!orders.length) {
      container.innerHTML = '<div class="empty">No active orders right now.</div>';
      return;
    }
    let html = "<table><tr><th>ID</th><th>Status</th><th>Requester</th><th>Runner</th><th>Price</th></tr>";
    orders.forEach(o => {
      html += "<tr onclick=\"openOrder(" + o.id + ")\">" +
        "<td>#" + o.id + "</td>" +
        "<td><span class='badge " + o.status + "'>" + o.status + "</span></td>" +
        "<td>@" + (o.user_username || "?") + "</td>" +
        "<td>" + (o.runner_username ? "@" + o.runner_username : "—") + "</td>" +
        "<td>" + naira(o.total_price) + "</td>" +
        "</tr>";
    });
    html += "</table>";
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="empty">Error loading orders: ' + err.message + '</div>';
  }
}

async function loadBanned() {
  const container = document.getElementById("banned");
  container.innerHTML = "Loading...";
  try {
    const { users } = await api("/admin/api/users/banned");
    if (!users.length) {
      container.innerHTML = '<div class="empty">No banned users.</div>';
      return;
    }
    let html = "<table><tr><th>User ID</th><th>Username</th><th>Reason</th><th></th></tr>";
    users.forEach(u => {
      html += "<tr><td>" + u.id + "</td><td>@" + (u.username || "unknown") + "</td><td>" + (u.ban_reason || "—") + "</td>" +
        "<td><button class='btn-ghost' onclick=\"unbanUser('" + u.id + "')\">Unban</button></td></tr>";
    });
    html += "</table>";
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="empty">Error loading banned users: ' + err.message + '</div>';
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
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function resolveOrder(id, action) {
  try {
    await api("/admin/api/orders/" + id + "/" + action, { method: "POST" });
    toast("Order #" + id + " updated (" + action + ")");
    closeModal();
    loadOrders();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function banFromOrder(userId, orderId) {
  try {
    await api("/admin/api/users/" + userId + "/ban", {
      method: "POST",
      body: JSON.stringify({ reason: "Banned from order #" + orderId })
    });
    toast("User " + userId + " banned");
    closeModal();
    loadBanned();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function banUser() {
  const userId = document.getElementById("banUserId").value.trim();
  const reason = document.getElementById("banReason").value.trim();
  if (!userId) return toast("Enter a user ID first");
  try {
    await api("/admin/api/users/" + userId + "/ban", {
      method: "POST",
      body: JSON.stringify({ reason: reason || null })
    });
    toast("User " + userId + " banned");
    document.getElementById("banUserId").value = "";
    document.getElementById("banReason").value = "";
    loadBanned();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function unbanUser(userId) {
  try {
    await api("/admin/api/users/" + userId + "/unban", { method: "POST" });
    toast("User " + userId + " unbanned");
    loadBanned();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function loadAll() { loadOrders(); loadBanned(); }
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

    if (order.runner_id) {
      await bot.sendMessage(order.runner_id, `✅ Task #${order.id} was marked completed by an admin.\n\n📧 ${SUPPORT_EMAIL}`).catch(() => {});
    }
    await bot.sendMessage(order.user_id, `✅ Task #${order.id} was marked completed by an admin.\n\n📧 ${SUPPORT_EMAIL}`).catch(() => {});

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/orders/:id/reset", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    await supabase.from("orders").update({
      runner_id: null,
      runner_username: null,
      agreed_price: null,
      runner_payout: null,
      total_price: null,
      status: "open",
      payment_status: "pending"
    }).eq("id", Number(order.id));
    await supabase.from("offers").delete().eq("order_id", String(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "reset_to_open", { orderId: order.id });

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

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/orders/:id/refund", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    await supabase.from("orders").update({ status: "refunded", payment_status: "refunded" }).eq("id", Number(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "mark_refunded", { orderId: order.id });

    await bot.sendMessage(order.user_id, `💵 Your payment for task #${order.id} has been marked for refund by an admin. Reach out to ${SUPPORT_EMAIL} with any questions.`).catch(() => {});
    if (order.runner_id) {
      await bot.sendMessage(order.runner_id, `⚠️ Task #${order.id} was cancelled and refunded by an admin.`).catch(() => {});
    }

    return res.json({ ok: true, note: "Records updated only — process the real refund in Flutterwave." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/orders/:id/void", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    await supabase.from("orders").update({ status: "voided" }).eq("id", Number(order.id));
    await supabase.from("offers").delete().eq("order_id", String(order.id));
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "void_order", { orderId: order.id });

    await bot.sendMessage(order.user_id, `🗑 Your request #${order.id} was removed by an admin.\n\nContact ${SUPPORT_EMAIL} if you have questions.`).catch(() => {});
    if (order.runner_id) {
      await bot.sendMessage(order.runner_id, `🗑 Task #${order.id} was removed by an admin.`).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/users/banned", async (req, res) => {
  const { data: users, error } = await supabase.from("users").select("id, username, ban_reason").eq("banned", true);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ users: users || [] });
});

app.post("/admin/api/users/:id/ban", async (req, res) => {
  try {
    const targetId = req.params.id;
    const reason = (req.body && req.body.reason) || null;

    await supabase.from("users").update({
      banned: true,
      ban_reason: reason,
      banned_at: new Date().toISOString()
    }).eq("id", targetId);

    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "ban_user", { targetUserId: targetId, note: reason });
    await bot.sendMessage(targetId, banMessage({ ban_reason: reason })).catch(() => {});

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/users/:id/unban", async (req, res) => {
  try {
    const targetId = req.params.id;

    await supabase.from("users").update({ banned: false, ban_reason: null, banned_at: null }).eq("id", targetId);
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "unban_user", { targetUserId: targetId });
    await bot.sendMessage(targetId, "✅ Your Helply account has been reinstated. Send /start to continue.").catch(() => {});

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= SERVER =================
app.listen(3000, () => {
  console.log("🌐 Server running on port 3000");
});
