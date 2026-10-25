// Required env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, RUNNER_GROUP_ID,
// BASE_URL, PAYMENT_BASE_URL, FLW_WEBHOOK_SECRET, RUNNER_SIGNUP_FORM_URL,
// ADMIN_DASHBOARD_USER, ADMIN_DASHBOARD_PASSWORD   (optional: PRINTER_CHAT_ID)

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
  { command: "services",     description: "Browse Food Runs, Laundry, Printing, Errands" },
  { command: "becomehelper", description: "Sign up to earn as a Helper" },
  { command: "stats",        description: "See your Helper earnings" }
]).catch(err => console.log("Could not set command menu:", err.message));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const RUNNER_GROUP_ID        = process.env.RUNNER_GROUP_ID;
const GIGS_TOPIC_ID          = 2;
const BASE_URL               = process.env.BASE_URL;
const PAYMENT_BASE_URL       = process.env.PAYMENT_BASE_URL;
const MIN_PRICE              = 5;
const SUPPORT_EMAIL          = "helply.cu@gmail.com";
const RUNNER_SIGNUP_FORM_URL = process.env.RUNNER_SIGNUP_FORM_URL || "https://forms.gle/P8Gb7zmVHQQEZ9JB7";

// The printer's numeric Telegram ID. Paid print jobs are sent to this chat.
// IMPORTANT: the printer must open this bot in Telegram and tap Start at least once;
// Telegram does not let a bot message someone who hasn't. You can override the ID with
// the PRINTER_CHAT_ID variable in Railway (it must be the NUMERIC ID, not a @username).
const DEFAULT_PRINTER_CHAT_ID = "8912345642";
const PRINTER_CHAT_ID_ENV     = (process.env.PRINTER_CHAT_ID || "").trim();
const PRINTER_CHAT_ID         = /^-?\d+$/.test(PRINTER_CHAT_ID_ENV) ? PRINTER_CHAT_ID_ENV : DEFAULT_PRINTER_CHAT_ID;
if (PRINTER_CHAT_ID_ENV && PRINTER_CHAT_ID_ENV !== PRINTER_CHAT_ID) {
  console.log(`PRINTER_CHAT_ID "${PRINTER_CHAT_ID_ENV}" is not a numeric Telegram ID - using the default instead.`);
}
const PRICE_PER_PAGE_BW    = Number(process.env.PRICE_PER_PAGE_BW    || 20);
const PRICE_PER_PAGE_COLOR = Number(process.env.PRICE_PER_PAGE_COLOR || 100);
const BINDING_FEE          = Number(process.env.BINDING_FEE          || 200);

function computePrintCost(pages, color, binding) {
  const perPage = color === "color" ? PRICE_PER_PAGE_COLOR : PRICE_PER_PAGE_BW;
  let cost = perPage * Number(pages || 0);
  if (binding) cost += BINDING_FEE;
  return cost;
}

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
- Your name, email and phone number are shared with our payment provider to process your payments
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

// ================= INPUT VALIDATION =================
// Keeps junk like "xyz" / "asdf" / "abc" out of the system, so every request
// that reaches the Helpers is something they can actually act on.
// These are heuristics (no AI involved): they catch the common kinds of
// junk — filler words, keyboard mashing, alphabet runs, repeated letters,
// symbols/emoji/numbers only — and let normal requests through.

const JUNK_WORDS = new Set([
  "xyz", "abc", "abcd", "asdf", "asdfg", "asdfgh", "qwerty", "qwe", "zxc",
  "test", "testing", "tests", "sample", "dummy", "fake", "random", "blah", "foo", "bar",
  "hi", "hello", "hey", "yo", "ok", "okay", "yes", "no", "nope", "nil", "none", "nothing", "na",
  "idk", "lol", "lmao", "hmm", "hmmm", "something", "anything", "whatever", "stuff", "thing", "things"
]);

// Words that make no sense as a place to meet/deliver.
const LOCATION_JUNK_WORDS = new Set([
  ...JUNK_WORDS, "here", "there", "anywhere", "somewhere", "anyhow", "location"
]);

// Real short words/abbreviations that have no vowel (so they'd otherwise look like junk).
const ABBREVIATIONS = new Set(["cv", "tv", "pdf", "pc", "hp", "ps", "sd", "ac", "dstv", "gotv", "id"]);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")   // ọ, ẹ, é ... -> o, e, e
    .split(/[^a-z0-9']+/)
    .map(t => t.replace(/'/g, ""))
    .filter(Boolean);
}

// "abc", "xyz", "qwerty", "asdf", "mnb" ... (alphabet runs / keyboard rows, either direction)
function isSequenceOrMash(t) {
  if (t.length < 3 || !/^[a-z]+$/.test(t)) return false;
  const rev = [...t].reverse().join("");
  if (KEYBOARD_ROWS.some(row => row.includes(t) || row.includes(rev))) return true;
  const codes = [...t].map(c => c.charCodeAt(0));
  const asc  = codes.every((c, i) => i === 0 || c === codes[i - 1] + 1);
  const desc = codes.every((c, i) => i === 0 || c === codes[i - 1] - 1);
  return asc || desc;
}

function isWordlike(t, junk = JUNK_WORDS) {
  if (t.length === 1) return t === "a" || t === "i";
  if (/\d/.test(t)) return true;                      // a4, 80gsm, 2nd
  if (junk.has(t)) return false;
  if (ABBREVIATIONS.has(t)) return true;
  if (isSequenceOrMash(t)) return false;              // abc, xyz, qwerty, asdf
  if (!/[aeiouy]/.test(t)) return false;              // sdf, hmm, brr
  if (/^(.)\1+$/.test(t)) return false;               // aaa, zzz
  if (/(.)\1{3,}/.test(t)) return false;              // aaaa, hhhhh
  if (/[^aeiouy]{6,}/.test(t)) return false;          // long consonant runs
  return true;
}

// Returns the cleaned request text, or null if it isn't a proper request.
function validateRequestText(input) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (text.length < 6 || text.length > 300) return null;
  if (containsPhoneLikeNumber(text)) return null;

  const nonSpace = text.replace(/\s/g, "");
  const letters  = (nonSpace.match(/\p{L}/gu) || []).length;
  if (letters < 5 || letters / nonSpace.length < 0.5) return null;   // mostly digits/symbols/emoji

  // Single letters and plain numbers are neutral; judge the actual words.
  const considered = tokenize(text).filter(t => t.length >= 2 && !/^\d+$/.test(t));
  const real       = considered.filter(t => isWordlike(t));

  if (real.length < 2) return null;                           // need at least two real words
  if (real.length / considered.length < 0.6) return null;     // mostly gibberish
  return text;
}

// Returns the cleaned location, or null if it doesn't look like a real place.
function validateLocation(input) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (text.length < 3 || text.length > 120) return null;
  if (containsPhoneLikeNumber(text)) return null;

  const considered = tokenize(text).filter(t => t.length >= 2 && !/^\d+$/.test(t));
  const real       = considered.filter(t => isWordlike(t, LOCATION_JUNK_WORDS));

  // At least one real word of 3+ letters ("library", "hall", "gate", "room"...).
  if (!real.some(t => t.length >= 3)) return null;
  if (real.length / considered.length < 0.5) return null;
  return text;
}

function validatePaperType(input) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (text.length < 2 || text.length > 40) return null;
  if (!tokenize(text).some(t => t.length >= 2 && isWordlike(t))) return null;
  return text;
}

// Anything that looks like a phone number or other long random number
// (7+ digits, optionally spaced/dashed). Blocked in requests and locations:
// it's almost always junk, and phone numbers there would let people take the
// conversation (and the payment) off Helply. Once a Helper is matched and the
// task is paid for, the two of them can chat right here in the bot.
function containsPhoneLikeNumber(text) {
  return /\d(?:[\s\-.]?\d){6,}/.test(String(text));
}

// Digits that look made-up: 0000000, 1111111, 12345678, 98765432, 080808080...
function looksFakeDigits(digits) {
  if (/^(\d)\1+$/.test(digits)) return true;          // all the same digit
  if (/(\d)\1{4,}/.test(digits)) return true;         // 5+ of the same digit in a row
  if (/(\d{2,3})\1{2,}/.test(digits)) return true;    // a short chunk repeated: 8080808080, 123123123

  const counts = {};
  for (const d of digits) counts[d] = (counts[d] || 0) + 1;
  if (Math.max(...Object.values(counts)) >= Math.ceil(digits.length * 0.6)) return true;  // one digit dominates

  let up = 1, down = 1;
  for (let i = 1; i < digits.length; i++) {
    const diff = Number(digits[i]) - Number(digits[i - 1]);
    up   = diff === 1  ? up + 1   : 1;
    down = diff === -1 ? down + 1 : 1;
    if (up >= 5 || down >= 5) return true;            // 12345, 98765
  }
  return false;
}

const MAX_PRINT_PAGES = 500;

// "10", "10 pages", "10pg" -> 10. Anything else (12abc, 0, 9999, 1e3) -> null.
function parsePageCount(input) {
  const m = String(input || "").trim().match(/^(\d{1,4})\s*(?:pages?|pgs?)?$/i);
  const n = m ? parseInt(m[1], 10) : NaN;
  return n >= 1 && n <= MAX_PRINT_PAGES ? n : null;
}

// Names that are obviously not real names.
const NAME_JUNK_WORDS = new Set([
  "xyz", "abc", "abcd", "asdf", "asdfg", "qwerty", "test", "testing", "sample", "dummy", "fake",
  "random", "user", "name", "hello", "hi", "hey", "none", "nil", "idk", "lol", "blah", "foo", "bar"
]);

// Throwaway / placeholder email domains.
const FAKE_EMAIL_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "test.com", "domain.com", "email.com",
  "abc.com", "xyz.com", "asdf.com", "mailinator.com", "yopmail.com", "tempmail.com",
  "guerrillamail.com", "10minutemail.com", "trashmail.com"
]);

const NO_PHONE_HELP =
  "❌ Please don't put phone numbers or long numbers here — describe what you need in words instead. " +
  "Once a Helper is matched and you've paid, you can chat with them right here in the bot.";

function requestError(text)  { return containsPhoneLikeNumber(text) ? NO_PHONE_HELP : REQUEST_HELP; }
function locationError(text) { return containsPhoneLikeNumber(text) ? NO_PHONE_HELP : LOCATION_HELP; }

const REQUEST_HELP =
  "❌ I couldn't make sense of that. Please tell me what you need in a few words — for example:\n\n" +
  "• Buy jollof rice and chicken from the cafeteria\n" +
  "• Print and bind my 20-page project\n" +
  "• Pick up my parcel from the gate\n\n" +
  "Try again:";

const LOCATION_HELP =
  "❌ That doesn't look like a real location. Tell the Helper where to meet you or drop it off — for example:\n\n" +
  "• Block B, Room 204\n" +
  "• Library main entrance\n\n" +
  "Try again:";

const PAPER_HELP = "❌ Please enter a paper type, e.g. A4, A3, Foolscap or Glossy.";

// ================= SIGN-UP GATE =================
// Every first-timer must sign up before they can use anything in the bot:
//   1) accept the Terms, then
//   2) give their full name, email and phone number (needed to process
//      their payments through Flutterwave).
// Progress is worked out from the database (not memory), so a restart or
// redeploy in the middle of sign-up never loses anyone's place.

async function sendTermsPrompt(userId) {
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Needs a real-looking first and last name (letters only, plus . ' -).
function cleanFullName(input) {
  const name = String(input || "").trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 80) return null;
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(name)) return null;
  if (name.split(" ").length < 2) return null;

  const parts = tokenize(name).filter(t => t.length >= 2);          // ignore initials like "O."
  if (parts.length < 2) return null;
  if (!parts.every(t => isWordlike(t, NAME_JUNK_WORDS))) return null;   // Xyz Abc, Asdf Qwerty, Test User
  return name;
}

function cleanEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;

  const [local, domain] = email.split("@");
  if (FAKE_EMAIL_DOMAINS.has(domain)) return null;

  const letters = local.replace(/[^a-z]/g, "");
  if (letters.length >= 3 &&
      (JUNK_WORDS.has(letters) || isSequenceOrMash(letters) || /^(.)\1+$/.test(letters))) return null;   // xyz@, asdf@, aaaa@
  if (/^\d+$/.test(local) && (local.length < 8 || looksFakeDigits(local))) return null;               // 12345@gmail.com
  return email;
}

// Accepts real-looking numbers only:
//   Nigerian mobiles — 080XXXXXXXX / +23480XXXXXXXX / 23480XXXXXXXX (prefixes 70, 80, 81, 90, 91),
//   or another country's number written as +<country code><number>.
// Rejects made-up ones (00000000000, 11111111111, 12345678901, 08080808080 ...).
// Always returns the number as +<digits>, or null.
function cleanPhone(input) {
  const p = String(input || "").trim().replace(/[\s\-().]/g, "");

  let national = null;
  let e164 = null;
  if (/^0\d{10}$/.test(p))          { national = p.slice(1); e164 = "+234" + national; }
  else if (/^234\d{10}$/.test(p))   { national = p.slice(3); e164 = "+" + p; }
  else if (/^\+234\d{10}$/.test(p)) { national = p.slice(4); e164 = p; }

  if (national) {
    if (!/^(70|80|81|90|91)\d{8}$/.test(national)) return null;    // not a real Nigerian mobile prefix
    return looksFakeDigits(national) ? null : e164;
  }

  if (/^\+?234/.test(p)) return null;                              // looked Nigerian but wrong length
  if (/^\+\d{8,15}$/.test(p)) return looksFakeDigits(p.slice(1)) ? null : p;
  return null;
}

function nextMissingDetail(user) {
  if (!user.full_name) return "full_name";
  if (!user.email)     return "email";
  if (!user.phone)     return "phone";
  return null;
}

// Signed up = accepted the Terms AND gave all three details.
function isSignedUp(user) {
  return !!(user && user.accepted_terms && !nextMissingDetail(user));
}

// Telegram's own "share my number" button: the number it sends has been
// verified by Telegram, so it can't be made up.
const PHONE_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

const DETAIL_PROMPTS = {
  full_name: "👤 What's your full name? (first and last name)",
  email:     "📧 What's your email address? (a real one — it's used for your payment receipts)",
  phone:     "📱 What's your phone number?\n\nTap the button below to share it — that's the quickest way. Or type it, e.g. 080XXXXXXXX."
};

async function sendDetailPrompt(userId, field, intro = "") {
  return bot.sendMessage(userId, `${intro}${DETAIL_PROMPTS[field]}`, field === "phone" ? PHONE_KEYBOARD : undefined);
}

// Treats the user's message as their answer to the detail we're asking for.
// `text` is their typed answer (or null); `contact` is a shared Telegram contact (or null).
async function handleSignupAnswer(userId, user, field, text, contact) {
  let value = null;
  let verified = false;
  let errorText = "";

  if (field === "full_name") {
    value = text === null ? null : cleanFullName(text);
    errorText = "❌ Please enter your real full name — first and last name (letters only).";
  } else if (field === "email") {
    value = text === null ? null : cleanEmail(text);
    errorText = "❌ That doesn't look like a real email address. Try again (e.g. yourname@gmail.com).";
  } else if (field === "phone") {
    if (contact) {
      // Only accept the user's OWN contact (not a friend's) from the share button.
      if (String(contact.user_id) === userId) {
        const digits = String(contact.phone_number || "").replace(/\D/g, "");
        if (digits.length >= 8 && digits.length <= 15) { value = "+" + digits; verified = true; }
      }
      errorText = "❌ Please share your own number with the button below, or type it.";
    } else {
      value = text === null ? null : cleanPhone(text);
      errorText = "❌ That doesn't look like a real phone number. Tap the button below to share yours, or type a valid number (e.g. 080XXXXXXXX).";
    }
  }

  if (!value) {
    return bot.sendMessage(userId, errorText, field === "phone" ? PHONE_KEYBOARD : undefined);
  }

  const { error } = await supabase.from("users").update({ [field]: value }).eq("id", userId);
  if (error) {
    console.log("SIGNUP DETAIL SAVE ERROR:", error.message);
    return bot.sendMessage(userId, "❌ Something went wrong saving that. Please try again.");
  }

  if (verified) {
    // Best-effort: remember that Telegram verified this number.
    const { error: vErr } = await supabase.from("users").update({ phone_verified: true }).eq("id", userId);
    if (vErr) console.log("PHONE VERIFIED SAVE ERROR:", vErr.message);
  }

  const next = nextMissingDetail({ ...user, [field]: value });
  if (next) return sendDetailPrompt(userId, next);

  return bot.sendMessage(
    userId,
    "🎉 You're all set! Send your request, or use the buttons below anytime.",
    mainReplyKeyboard
  );
}

// Returns the user row only if they're fully signed up and not banned.
// Otherwise it replies with the right prompt (Terms / next detail /
// suspension) and returns null, so callers can just `if (!user) return;`.
// Pass `answerText` (a plain text message) so that, mid-sign-up, it's
// treated as the answer to the detail being asked for.
async function ensureSignedUp(from, answerText = null, contact = null) {
  const userId = from.id.toString();
  try {
    let { data: user } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();

    if (!user) {
      // Brand-new user: create the account as NOT yet signed up.
      // ignoreDuplicates keeps this safe if two messages arrive at once.
      const { error } = await supabase.from("users").upsert(
        [{ id: userId, username: from.username || "", accepted_terms: false, banned: false }],
        { onConflict: "id", ignoreDuplicates: true }
      );
      if (error) console.log("SIGNUP INSERT ERROR:", error.message);
      user = { id: userId, accepted_terms: false };
    }

    if (user.banned) {
      await bot.sendMessage(userId, banMessage(user));
      return null;
    }

    if (!user.accepted_terms) {
      await sendTermsPrompt(userId);
      return null;
    }

    const missing = nextMissingDetail(user);
    if (missing) {
      if (answerText !== null || contact) {
        await handleSignupAnswer(userId, user, missing, answerText, contact);
      } else {
        await sendDetailPrompt(userId, missing, "📝 Let's finish setting up your account first.\n\n");
      }
      return null;
    }

    return user;
  } catch (err) {
    console.log("SIGNUP CHECK ERROR:", err.message);
    return null;
  }
}

function offerButtons(offerId, forRunner) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Accept",  callback_data: `accept_${offerId}` }],
        [{ text: "💬 Counter", callback_data: forRunner ? `counter_runner_${offerId}` : `counter_${offerId}` }],
        [{ text: "❌ Reject",  callback_data: `reject_${offerId}` }]
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

const DEFAULT_OFFER_START = 200;

async function sendPriceAdjuster(chatId, price, kind, refId, editMessageId) {
  const text     = `💰 Set the offer amount: ₦${price}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "-1000", callback_data: `padj_${kind}_${refId}_${price}_-1000` },
        { text: "-500",  callback_data: `padj_${kind}_${refId}_${price}_-500`  },
        { text: "-50",   callback_data: `padj_${kind}_${refId}_${price}_-50`   }
      ],
      [
        { text: "+50",   callback_data: `padj_${kind}_${refId}_${price}_50`    },
        { text: "+500",  callback_data: `padj_${kind}_${refId}_${price}_500`   },
        { text: "+1000", callback_data: `padj_${kind}_${refId}_${price}_1000`  }
      ],
      [{ text: "✅ Submit", callback_data: `psub_${kind}_${refId}_${price}` }]
    ]
  };

  if (editMessageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, reply_markup: keyboard });
  }
  return bot.sendMessage(chatId, text, { reply_markup: keyboard });
}

// ================= PRINTING =================

async function finalizePrintingOrder(msg, userId, printData) {
  let taskId;
  try {
    taskId = await generateUniqueTaskId();
  } catch (e) {
    clearPendingState(userId);
    return bot.sendMessage(userId, "❌ Something went wrong creating your print request. Please try again.");
  }

  const printCost  = computePrintCost(printData.pages, printData.color, printData.binding);
  const colorLabel = printData.color === "color" ? "Color" : "Black & White";
  const requestText = `[Printing] ${printData.pages} page(s), ${colorLabel}, ${printData.paper}` +
    `${printData.binding ? ", Binding" : ""}${printData.note ? ` — Note: ${printData.note}` : ""}`;

  const printFileId   = msg.document ? msg.document.file_id : msg.photo[msg.photo.length - 1].file_id;
  const printFileType = msg.document ? "document" : "photo";

  const { error } = await supabase.from("orders").insert([{
    id:                taskId,
    user_id:           userId,
    user_username:     msg.from.username || "",
    request_text:      requestText,
    delivery_location: printData.location,
    status:            "open",
    payment_status:    "pending",
    category:          "Printing",
    print_color:       printData.color,
    print_paper:       printData.paper,
    print_pages:       printData.pages,
    print_binding:     !!printData.binding,
    print_note:        printData.note || null,
    print_cost:        printCost,
    print_file_id:     printFileId,
    print_file_type:   printFileType
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

// ================= LAUNDRY =================

async function finalizeLaundryOrder(msg, userId, state) {
  const { requestText, locationText } = state;

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
    category:          "Laundry"
  }]);

  clearPendingState(userId);

  if (error) {
    console.log("LAUNDRY ORDER INSERT ERROR:", error.message);
    return bot.sendMessage(userId, "❌ Something went wrong creating your request. Please try again.");
  }

  await bot.sendMessage(
    userId,
    `✅ Request sent successfully!\n\n🆔 Request ID: ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}\n\n⏳ Please wait while we match you with a Helper...`,
    { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Request", callback_data: `cancelreq_${taskId}` }]] } }
  );

  const caption      = `🚨 NEW REQUEST\n\n🆔 ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}`;
  const groupOptions = {
    caption,
    message_thread_id: GIGS_TOPIC_ID,
    reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${taskId}` }]] }
  };

  try {
    if (msg.photo) {
      await bot.sendPhoto(RUNNER_GROUP_ID, msg.photo[msg.photo.length - 1].file_id, groupOptions);
    } else {
      await bot.sendDocument(RUNNER_GROUP_ID, msg.document.file_id, groupOptions);
    }
  } catch (err) {
    console.log("LAUNDRY RUNNER GROUP POST ERROR:", err.message);
    await bot.sendMessage(RUNNER_GROUP_ID, caption, {
      message_thread_id: GIGS_TOPIC_ID,
      reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${taskId}` }]] }
    });
  }
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

// ================= REPLY KEYBOARD =================

const BTN_SERVICES      = "📋 Our Services";
const BTN_BECOME_HELPER = "🏃 Become a Helper";
const BTN_STATS         = "📊 My Stats";
const BTN_HELP          = "❓ Help";

const mainReplyKeyboard = {
  reply_markup: {
    keyboard: [
      [BTN_SERVICES],
      [BTN_BECOME_HELPER, BTN_STATS],
      [BTN_HELP]
    ],
    resize_keyboard: true,
    is_persistent:  true
  }
};

const SERVICE_CATEGORIES = {
  food:     "Food Runs",
  laundry:  "Laundry",
  printing: "Printing",
  errand:   "Errands"
};

async function sendServicesMenu(userId) {
  return bot.sendMessage(userId, "📋 What do you need help with today?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🍔 Food Runs",       callback_data: "service_food"     }],
        [{ text: "🧺 Laundry",         callback_data: "service_laundry"  }],
        [{ text: "🖨️ Printing",        callback_data: "service_printing" }],
        [{ text: "🏃 Errands",         callback_data: "service_errand"   }],
        [{ text: "✏️ Something else",  callback_data: "service_other"    }]
      ]
    }
  });
}

// ================= FOOD MENUS =================
// To add a restaurant, change a price or hide something, edit FOOD_RESTAURANTS.
// Rules: restaurant ids and group ids must not contain "_"; item ids must be unique.
// A group with ONE item is added straight to the cart when tapped; a group with
// several items (e.g. pizza sizes) opens a small picker first.

const FOOD_RESTAURANTS = [
  {
    id: "pr",
    name: "Pizza Republic",
    active: true,
    groups: [
      { id: "burger", label: "🍔 Burger", items: [
        { id: "pr_burger", name: "Burger", short: "Burger", price: 2000 }
      ]},
      { id: "bbq", label: "🍕 Chicken BBQ Pizza", items: [
        { id: "pr_bbq_s", name: "Chicken BBQ Pizza (Small)",  short: "BBQ Small",  size: "Small",  price: 3500 },
        { id: "pr_bbq_m", name: "Chicken BBQ Pizza (Medium)", short: "BBQ Medium", size: "Medium", price: 4500 },
        { id: "pr_bbq_b", name: "Chicken BBQ Pizza (Big)",    short: "BBQ Big",    size: "Big",    price: 6500 }
      ]},
      { id: "suya", label: "🍕 Chicken Suya Pizza", items: [
        { id: "pr_suya_s", name: "Chicken Suya Pizza (Small)",  short: "Suya Small",  size: "Small",  price: 3500 },
        { id: "pr_suya_m", name: "Chicken Suya Pizza (Medium)", short: "Suya Medium", size: "Medium", price: 4500 },
        { id: "pr_suya_b", name: "Chicken Suya Pizza (Big)",    short: "Suya Big",    size: "Big",    price: 6500 }
      ]},
      { id: "pep", label: "🍕 Pepperoni Pizza", items: [
        { id: "pr_pep_s", name: "Pepperoni Pizza (Small)",  short: "Pepperoni Small",  size: "Small",  price: 3500 },
        { id: "pr_pep_m", name: "Pepperoni Pizza (Medium)", short: "Pepperoni Medium", size: "Medium", price: 4500 },
        { id: "pr_pep_b", name: "Pepperoni Pizza (Big)",    short: "Pepperoni Big",    size: "Big",    price: 6500 }
      ]},
      { id: "extras", label: "➕ Extras (toppings)", items: [
        { id: "pr_xcheese",  name: "Extra Cheese (Topping)",  short: "Extra Cheese",  price: 1000 },
        { id: "pr_xchicken", name: "Extra Chicken (Topping)", short: "Extra Chicken", price: 500 }
      ]}
    ]
  }
];

const FOOD_MAX_PER_ITEM = 10;
const FOOD_MAX_ITEMS    = 20;

function findFoodRestaurant(id) {
  return FOOD_RESTAURANTS.find(r => r.id === id && r.active) || null;
}

function findFoodItem(itemId) {
  for (const restaurant of FOOD_RESTAURANTS) {
    for (const group of restaurant.groups) {
      for (const item of group.items) {
        if (item.id === itemId) return { restaurant, group, item };
      }
    }
  }
  return null;
}

// The cart lives in pendingState (like the printing flow), so it resets if the bot restarts.
function getFoodCart(userId, restaurantId) {
  const st = pendingState[userId];
  if (!st || st.mode !== "food_cart" || st.restaurantId !== restaurantId) {
    pendingState[userId] = { mode: "food_cart", restaurantId, cart: {} };
  }
  return pendingState[userId].cart;
}

function foodCartCount(cart) {
  return Object.values(cart).reduce((sum, qty) => sum + qty, 0);
}

// Items in the cart, in menu order: [{ item, qty }]
function foodCartLines(restaurant, cart) {
  const lines = [];
  for (const group of restaurant.groups) {
    for (const item of group.items) {
      if (cart[item.id] > 0) lines.push({ item, qty: cart[item.id] });
    }
  }
  return lines;
}

function foodCartTotal(restaurant, cart) {
  return foodCartLines(restaurant, cart).reduce((sum, { item, qty }) => sum + item.price * qty, 0);
}

function foodLinesText(lines) {
  return lines.map(({ item, qty }) => `• ${qty}× ${item.name} — ${formatNaira(item.price * qty)}`).join("\n");
}

function renderFoodMenu(restaurant, cart) {
  const lines = foodCartLines(restaurant, cart);

  let text = `🍽️ ${restaurant.name}\n\nTap an item to add it to your order.\n\n`;
  if (lines.length) {
    text += `🛒 Your order:\n${foodLinesText(lines)}\n\n💰 Food total: ${formatNaira(foodCartTotal(restaurant, cart))}`;
  } else {
    text += "🛒 Your order is empty.";
  }
  text += "\n\nPrices are the restaurant's and may change.";

  const rows = restaurant.groups.map(group => {
    if (group.items.length === 1) {
      const item = group.items[0];
      return [{ text: `${group.label} — ${formatNaira(item.price)}`, callback_data: `food_add_${item.id}` }];
    }
    return [{ text: group.label, callback_data: `food_grp_${restaurant.id}_${group.id}` }];
  });

  if (lines.length) {
    rows.push([
      { text: "🛒 Edit cart",             callback_data: `food_cart_${restaurant.id}` },
      { text: "✅ Done — add location",   callback_data: `food_done_${restaurant.id}` }
    ]);
  }
  rows.push([{ text: "✏️ Order from somewhere else", callback_data: "food_other" }]);
  rows.push([{ text: "❌ Cancel", callback_data: "food_cancel" }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

function renderFoodGroup(restaurant, group) {
  const rows = group.items.map(item => [{
    text: `${item.size || item.short} — ${formatNaira(item.price)}`,
    callback_data: `food_add_${item.id}`
  }]);
  rows.push([{ text: "⬅️ Back to menu", callback_data: `food_menu_${restaurant.id}` }]);
  return { text: `${group.label}\n\nPick one to add it to your order.`, reply_markup: { inline_keyboard: rows } };
}

function renderFoodCart(restaurant, cart) {
  const lines = foodCartLines(restaurant, cart);
  const text =
    `🛒 Your order — ${restaurant.name}\n\n${foodLinesText(lines)}\n\n` +
    `💰 Food total: ${formatNaira(foodCartTotal(restaurant, cart))}\n\nUse ➖ / ➕ to change quantities.`;

  const rows = lines.map(({ item, qty }) => [
    { text: "➖",                      callback_data: `food_dec_${item.id}` },
    { text: `${qty}× ${item.short}`,  callback_data: "food_noop" },
    { text: "➕",                      callback_data: `food_inc_${item.id}` }
  ]);
  rows.push([
    { text: "🗑 Clear",          callback_data: `food_clear_${restaurant.id}` },
    { text: "⬅️ Back to menu",   callback_data: `food_menu_${restaurant.id}` }
  ]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Called when someone taps Food Runs. Returns false if there's no active
// restaurant, so the caller can fall back to the free-text request flow.
async function startFoodOrder(userId) {
  const active = FOOD_RESTAURANTS.filter(r => r.active);
  if (active.length === 0) return false;

  if (active.length === 1) {
    pendingState[userId] = { mode: "food_cart", restaurantId: active[0].id, cart: {} };
    const screen = renderFoodMenu(active[0], {});
    await bot.sendMessage(userId, screen.text, { reply_markup: screen.reply_markup });
    return true;
  }

  const rows = active.map(r => [{ text: `🍽️ ${r.name}`, callback_data: `food_rest_${r.id}` }]);
  rows.push([{ text: "✏️ Somewhere else", callback_data: "food_other" }]);
  rows.push([{ text: "❌ Cancel",         callback_data: "food_cancel" }]);
  await bot.sendMessage(userId, "🍽️ Where would you like to order from?", { reply_markup: { inline_keyboard: rows } });
  return true;
}

async function handleFoodCallback(q, data, userId) {
  const chatId    = q.message.chat.id;
  const messageId = q.message.message_id;

  // Edit the menu message in place (ignores Telegram's "message is not modified").
  async function show(text, reply_markup) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup });
    } catch (err) {
      if (!/not modified/i.test(err.message)) console.log("FOOD MENU EDIT ERROR:", err.message);
    }
  }

  if (data === "food_noop") return bot.answerCallbackQuery(q.id);

  if (data === "food_cancel") {
    clearPendingState(userId);
    await show("❌ Food order cancelled.", { inline_keyboard: [] });
    return bot.answerCallbackQuery(q.id);
  }

  // Not on the menu: fall back to typing the request
  if (data === "food_other") {
    pendingState[userId] = { mode: "category_detail", category: "Food Runs" };
    await show("✏️ Custom food order", { inline_keyboard: [] });
    await bot.sendMessage(userId, "📝 Tell me what you need (e.g. \"2 portions of jollof rice and chicken from Mama Put\"):");
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("food_rest_")) {
    const restaurant = findFoodRestaurant(data.slice("food_rest_".length));
    if (!restaurant) return denyCallback(q, "❌ That restaurant isn't available right now");
    pendingState[userId] = { mode: "food_cart", restaurantId: restaurant.id, cart: {} };
    const screen = renderFoodMenu(restaurant, {});
    await show(screen.text, screen.reply_markup);
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("food_menu_")) {
    const restaurant = findFoodRestaurant(data.slice("food_menu_".length));
    if (!restaurant) return denyCallback(q, "❌ That restaurant isn't available right now");
    const screen = renderFoodMenu(restaurant, getFoodCart(userId, restaurant.id));
    await show(screen.text, screen.reply_markup);
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("food_grp_")) {
    const [, , restaurantId, groupId] = data.split("_");
    const restaurant = findFoodRestaurant(restaurantId);
    const group = restaurant && restaurant.groups.find(g => g.id === groupId);
    if (!group) return denyCallback(q, "❌ That item isn't available right now");
    const screen = renderFoodGroup(restaurant, group);
    await show(screen.text, screen.reply_markup);
    return bot.answerCallbackQuery(q.id);
  }

  // Add from the menu / a size picker -> back to the menu
  if (data.startsWith("food_add_")) {
    const found = findFoodItem(data.slice("food_add_".length));
    if (!found || !findFoodRestaurant(found.restaurant.id)) return denyCallback(q, "❌ That item isn't available right now");

    const cart = getFoodCart(userId, found.restaurant.id);
    if ((cart[found.item.id] || 0) >= FOOD_MAX_PER_ITEM || foodCartCount(cart) >= FOOD_MAX_ITEMS) {
      return denyCallback(q, "❌ That's the maximum quantity for one order");
    }
    cart[found.item.id] = (cart[found.item.id] || 0) + 1;

    await bot.answerCallbackQuery(q.id, { text: `✅ Added ${found.item.name}` });
    const screen = renderFoodMenu(found.restaurant, cart);
    return show(screen.text, screen.reply_markup);
  }

  if (data.startsWith("food_cart_")) {
    const restaurant = findFoodRestaurant(data.slice("food_cart_".length));
    if (!restaurant) return denyCallback(q, "❌ That restaurant isn't available right now");
    const cart = getFoodCart(userId, restaurant.id);
    const screen = foodCartLines(restaurant, cart).length ? renderFoodCart(restaurant, cart) : renderFoodMenu(restaurant, cart);
    await show(screen.text, screen.reply_markup);
    return bot.answerCallbackQuery(q.id);
  }

  // + / - inside the cart screen
  if (data.startsWith("food_inc_") || data.startsWith("food_dec_")) {
    const isInc = data.startsWith("food_inc_");
    const found = findFoodItem(data.slice("food_inc_".length));   // same length as "food_dec_"
    if (!found || !findFoodRestaurant(found.restaurant.id)) return denyCallback(q, "❌ That item isn't available right now");

    const cart = getFoodCart(userId, found.restaurant.id);
    const current = cart[found.item.id] || 0;

    if (isInc) {
      if (current >= FOOD_MAX_PER_ITEM || foodCartCount(cart) >= FOOD_MAX_ITEMS) {
        return denyCallback(q, "❌ That's the maximum quantity for one order");
      }
      cart[found.item.id] = current + 1;
    } else if (current <= 1) {
      delete cart[found.item.id];
    } else {
      cart[found.item.id] = current - 1;
    }

    await bot.answerCallbackQuery(q.id);
    const screen = foodCartLines(found.restaurant, cart).length
      ? renderFoodCart(found.restaurant, cart)
      : renderFoodMenu(found.restaurant, cart);
    return show(screen.text, screen.reply_markup);
  }

  if (data.startsWith("food_clear_")) {
    const restaurant = findFoodRestaurant(data.slice("food_clear_".length));
    if (!restaurant) return denyCallback(q, "❌ That restaurant isn't available right now");
    const cart = getFoodCart(userId, restaurant.id);
    for (const key of Object.keys(cart)) delete cart[key];
    const screen = renderFoodMenu(restaurant, cart);
    await show(screen.text, screen.reply_markup);
    return bot.answerCallbackQuery(q.id);
  }

  // Done picking food -> now ask for the delivery location
  if (data.startsWith("food_done_")) {
    const restaurant = findFoodRestaurant(data.slice("food_done_".length));
    if (!restaurant) return denyCallback(q, "❌ That restaurant isn't available right now");

    const cart  = getFoodCart(userId, restaurant.id);
    const lines = foodCartLines(restaurant, cart);
    if (!lines.length) return denyCallback(q, "❌ Your order is empty — add something first");

    const total   = foodCartTotal(restaurant, cart);
    const summary = lines.map(({ item, qty }) => `${qty}× ${item.name}`).join(", ");

    // From here the normal request flow takes over: location -> post to Helpers.
    pendingState[userId] = {
      mode: "location",
      request: `[Food Runs] ${restaurant.name} — ${summary}`,
      category: "Food Runs",
      foodCost: total
    };

    await show(
      `🧾 Your order — ${restaurant.name}\n\n${foodLinesText(lines)}\n\n💰 Food total: ${formatNaira(total)}\n\n` +
      "You'll pay this plus the Helper's delivery fee (agreed with the Helper).",
      { inline_keyboard: [] }
    );
    await bot.sendMessage(userId, "📍 Where should the Helper deliver this?");
    return bot.answerCallbackQuery(q.id);
  }

  return denyCallback(q, "❌ Unknown action");
}

// ================= COMMAND HANDLERS =================

async function sendBecomeHelperMessage(userId) {
  return bot.sendMessage(
    userId,
    "🏃 Want to earn money completing tasks on campus?\n\nFill out the Helper signup form to get started:",
    { reply_markup: { inline_keyboard: [[{ text: "📝 Sign up as a Helper", url: RUNNER_SIGNUP_FORM_URL }]] } }
  );
}

async function sendStatsMessage(userId) {
  const user = await getUser(userId);
  if (!user) return bot.sendMessage(userId, "⚠️ Send /start first.");
  try {
    const stats = await computeRunnerStats(userId);
    return bot.sendMessage(userId, formatRunnerStats(stats), { parse_mode: "Markdown" });
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
Tap 📋 Our Services to pick a category (Food Runs, Laundry, Printing, Errands), or just type what you need — I'll ask where to meet you or drop it off, then post it to our Helpers.

*Buttons / Commands*
📋 Our Services — Browse what Helply can help with
🏃 Become a Helper — Sign up to earn money completing tasks
📊 My Stats — See your Helper earnings
/start — Main menu
/help — This message

Need a hand? 📧 ${SUPPORT_EMAIL}`,
    { parse_mode: "Markdown" }
  );
}

// ================= /start =================

bot.onText(/\/start/, async (msg) => {
  const user = await ensureSignedUp(msg.from);
  if (!user) return; // first-timers see the sign-up (terms) prompt instead

  const userId = msg.from.id.toString();
  clearPendingState(userId);
  return bot.sendMessage(
    userId,
    "🚀 Welcome back to Helply\n\nSend your request, or use the buttons below anytime.",
    mainReplyKeyboard
  );
});

bot.onText(/\/becomehelper/, async (msg) => {
  if (!(await ensureSignedUp(msg.from))) return;
  return sendBecomeHelperMessage(msg.from.id.toString());
});

bot.onText(/\/stats/, async (msg) => {
  if (!(await ensureSignedUp(msg.from))) return;
  return sendStatsMessage(msg.from.id.toString());
});

bot.onText(/\/services/, async (msg) => {
  if (!(await ensureSignedUp(msg.from))) return;
  return sendServicesMenu(msg.from.id.toString());
});

bot.onText(/\/help/, async (msg) => {
  if (!(await ensureSignedUp(msg.from))) return;
  return sendHelpMessage(msg.from.id.toString());
});

// ================= MESSAGE =================

bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;

  // Commands (/start, /help, ...) are handled by their own onText handlers,
  // each of which runs the sign-up check. Skip them here so a first-timer
  // doesn't get the sign-up prompt twice.
  if (msg.text && msg.text.startsWith("/")) return;

  const userId = msg.from.id.toString();

  // First-timers (and anyone who hasn't accepted the terms) must sign up
  // before the bot will do anything else for them.
  // (Reply-keyboard button taps aren't answers, so don't treat them as such.)
  const isButtonTap = [BTN_SERVICES, BTN_BECOME_HELPER, BTN_STATS, BTN_HELP].includes(msg.text);
  const currentUser = await ensureSignedUp(msg.from, isButtonTap ? null : (msg.text ?? null), msg.contact || null);
  if (!currentUser) return;

  const state = pendingState[userId];

  // ── Printing: document/photo upload ──────────────────────────────────────
  if (state?.mode === "print_upload_wait") {
    if (msg.document || msg.photo) return finalizePrintingOrder(msg, userId, state.printData);
    if (msg.text) return bot.sendMessage(userId, "📎 Please send the document as a file or photo (not text).");
    return;
  }

  // ── Laundry: photo of items ───────────────────────────────────────────────
  if (state?.mode === "laundry_photo_wait") {
    if (msg.document || msg.photo) return finalizeLaundryOrder(msg, userId, state);
    if (msg.text) return bot.sendMessage(userId, "📸 Please send a photo of your laundry (not text).");
    return;
  }

  if (!msg.text || msg.text.startsWith("/")) return;

  const text = msg.text.trim();

  // ── Reply keyboard buttons ────────────────────────────────────────────────
  if (text === BTN_SERVICES)      return sendServicesMenu(userId);
  if (text === BTN_BECOME_HELPER) return sendBecomeHelperMessage(userId);
  if (text === BTN_STATS)         return sendStatsMessage(userId);
  if (text === BTN_HELP)          return sendHelpMessage(userId);

  // ── Printing: paper type ──────────────────────────────────────────────────
  if (state?.mode === "print_paper") {
    const paper = validatePaperType(text);
    if (!paper) return bot.sendMessage(userId, PAPER_HELP);
    const printData = { ...state.printData, paper };
    pendingState[userId] = { mode: "print_pages", printData };
    return bot.sendMessage(userId, "📄 How many pages?");
  }

  // ── Printing: page count ──────────────────────────────────────────────────
  if (state?.mode === "print_pages") {
    const pages = parsePageCount(text);
    if (pages === null) {
      return bot.sendMessage(userId, `❌ Enter the number of pages as a number from 1 to ${MAX_PRINT_PAGES} (e.g. 10).`);
    }
    const printData = { ...state.printData, pages };
    pendingState[userId] = { mode: "print_binding_wait", printData };
    return bot.sendMessage(userId, "📎 Does it need binding?", {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Yes", callback_data: "printbinding_yes" },
          { text: "❌ No",  callback_data: "printbinding_no"  }
        ]]
      }
    });
  }

  // ── Printing: special note ────────────────────────────────────────────────
  if (state?.mode === "print_note") {
    const note = text.toLowerCase() === "none" ? null : text;
    if (note && (note.length > 200 || containsPhoneLikeNumber(note))) {
      return bot.sendMessage(userId, "❌ Please keep the note short (200 characters max) and don't include phone numbers.");
    }
    const printData = { ...state.printData, note };
    pendingState[userId] = { mode: "print_delivery_location", printData };
    return bot.sendMessage(userId, "📍 Where should the Helper meet you or drop this off?");
  }

  // ── Printing: delivery location ───────────────────────────────────────────
  if (state?.mode === "print_delivery_location") {
    const location = validateLocation(text);
    if (!location) return bot.sendMessage(userId, locationError(text));
    const printData = { ...state.printData, location };
    pendingState[userId] = { mode: "print_upload_wait", printData };
    return bot.sendMessage(userId, "📎 Now send the document you'd like printed — as a file or a photo.");
  }

  // ── Food menu: use the buttons ────────────────────────────────────────────
  if (state?.mode === "food_cart") {
    return bot.sendMessage(userId, "🍽️ Please use the buttons on the menu above to pick your food — or tap ❌ Cancel to start over.");
  }

  // ── Category detail ───────────────────────────────────────────────────────
  if (state?.mode === "category_detail") {
    const request = validateRequestText(text);
    if (!request) return bot.sendMessage(userId, requestError(text));
    const requestText = state.category ? `[${state.category}] ${request}` : request;
    pendingState[userId] = { mode: "location", request: requestText, category: state.category };
    return bot.sendMessage(userId, "📍 Where should the Helper meet you or drop this off?");
  }

  // ── Location step ─────────────────────────────────────────────────────────
  if (state?.mode === "location") {
    const requestText  = state.request;
    const locationText = validateLocation(text);
    if (!locationText) return bot.sendMessage(userId, locationError(text));

    // Set when the order came from the food menu
    const foodLine = state.foodCost
      ? `\n\n🍽 Food total: ${formatNaira(state.foodCost)} (added to your total once a Helper is matched)`
      : "";

    if (state.category === "Laundry") {
      pendingState[userId] = { mode: "laundry_photo_wait", requestText, locationText };
      return bot.sendMessage(userId, "📸 Please send a photo of what you'd like washed.");
    }

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
      ...(state.foodCost ? { category: "Food Runs", food_cost: state.foodCost } : {})
    }]);

    clearPendingState(userId);

    if (error) {
      console.log("ORDER INSERT ERROR:", error.message);
      return bot.sendMessage(userId, "❌ Something went wrong creating your request. Please try again.");
    }

    await bot.sendMessage(
      userId,
      `✅ Request sent successfully!\n\n🆔 Request ID: ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}${foodLine}\n\n⏳ Please wait while we match you with a Helper...`,
      { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Request", callback_data: `cancelreq_${taskId}` }]] } }
    );

    await bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW REQUEST\n\n🆔 ${taskId}\n\n📦 Request:\n${requestText}\n\n📍 Location:\n${locationText}${foodLine}`,
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

  // ── Guard: stray text during negotiation ──────────────────────────────────
  if (await hasActiveNegotiation(userId)) {
    return bot.sendMessage(userId, "💬 You have an active offer — use the buttons above to accept, counter, or reject it.");
  }

  // ── New request ───────────────────────────────────────────────────────────
  if (await isBusy(userId)) {
    return bot.sendMessage(userId, "❌ Finish your current task first");
  }

  const request = validateRequestText(text);
  if (!request) return bot.sendMessage(userId, requestError(text));

  pendingState[userId] = { mode: "location", request };
  await bot.sendMessage(userId, "📍 Where should the Helper meet you or drop this off?");
});

// ================= CALLBACK =================

bot.on("callback_query", async (q) => {
  const data   = q.data;
  const userId = q.from.id.toString();

  try {
    const requester = await getUser(userId);
    if (requester?.banned) return denyCallback(q, "🚫 Your account has been suspended.");

    // Only the sign-up buttons work until the user has finished signing up.
    if (!isSignedUp(requester) && data !== "accept_terms" && data !== "decline_terms") {
      return denyCallback(q, "⚠️ Please finish signing up first — open Helply privately and send /start");
    }

    // FOOD MENU buttons (pick items -> cart -> delivery location)
    if (data.startsWith("food_")) return await handleFoodCallback(q, data, userId);

    // SERVICES MENU
    if (data.startsWith("service_")) {
      const key = data.split("_")[1];

      // Food Runs opens the menu (when there's an active restaurant); otherwise it falls
      // through to the free-text request flow below.
      if (key === "food" && await startFoodOrder(userId)) return bot.answerCallbackQuery(q.id);

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
              { text: "⚫ Black & White", callback_data: "printcolor_bw"    },
              { text: "🎨 Color",         callback_data: "printcolor_color" }
            ]]
          }
        });
        return bot.answerCallbackQuery(q.id);
      }

      const category = SERVICE_CATEGORIES[key];
      if (!category) return denyCallback(q, "❌ Unknown service category");

      pendingState[userId] = { mode: "category_detail", category };
      await bot.sendMessage(userId, `📝 Tell me what you need for ${category}:`);
      return bot.answerCallbackQuery(q.id);
    }

    // PRINTING: COLOR CHOICE
    if (data.startsWith("printcolor_")) {
      const color     = data.split("_")[1];
      const printData = { ...(pendingState[userId]?.printData || {}), color };
      pendingState[userId] = { mode: "print_paper", printData };
      await bot.sendMessage(userId, "📄 What type of paper? (e.g. A4, Foolscap, Glossy)");
      return bot.answerCallbackQuery(q.id);
    }

    // PRINTING: BINDING CHOICE
    if (data.startsWith("printbinding_")) {
      const choice    = data.split("_")[1];
      const printData = { ...(pendingState[userId]?.printData || {}), binding: choice === "yes" };
      pendingState[userId] = { mode: "print_note", printData };
      await bot.sendMessage(userId, "📝 Any special note? (or type \"none\")");
      return bot.answerCallbackQuery(q.id);
    }

    // ACCEPT / DECLINE TERMS
    if (data === "accept_terms") {
      await supabase.from("users").update({ accepted_terms: true }).eq("id", userId);

      // Next sign-up step: their details (or finish, if they already have them).
      const fresh = await getUser(userId);
      const next = fresh ? nextMissingDetail(fresh) : "full_name";
      if (next) {
        await sendDetailPrompt(
          userId,
          next,
          "✅ Terms accepted!\n\nLast step — we need a few details so your payments can be processed. They're only shared with our payment provider.\n\n"
        );
      } else {
        await bot.sendMessage(userId, "🎉 You're in! Send your request, or use the buttons below anytime.", mainReplyKeyboard);
      }
      return bot.answerCallbackQuery(q.id);
    }
    if (data === "decline_terms") {
      await bot.sendMessage(userId, "You need to accept the terms to use Helply. Send /start when you're ready.");
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

      await sendPriceAdjuster(userId, DEFAULT_OFFER_START, "new", taskId);
      return bot.answerCallbackQuery(q.id);
    }

    // ADJUST PRICE
    if (data.startsWith("padj_")) {
      const [, kind, refId, currentPriceStr, changeStr] = data.split("_");
      let newPrice = Number(currentPriceStr) + Number(changeStr);
      if (newPrice < MIN_PRICE) newPrice = MIN_PRICE;

      await sendPriceAdjuster(q.message.chat.id, newPrice, kind, refId, q.message.message_id);
      return bot.answerCallbackQuery(q.id);
    }

    // SUBMIT PRICE
    if (data.startsWith("psub_")) {
      const [, kind, refId, priceStr] = data.split("_");
      const price = Number(priceStr);

      if (kind === "new") {
        const taskId = refId;
        const order  = await getOrder(taskId);
        if (!order)                  return denyCallback(q, "❌ Request not found");
        if (order.status !== "open") return denyCallback(q, "❌ This request is no longer available");

        const offerId = uuidv4();
        await supabase.from("offers").insert([{
          id:              offerId,
          order_id:        String(taskId),
          user_id:         order.user_id,
          runner_id:       userId,
          runner_name:     q.from.first_name,
          runner_username: q.from.username || "",
          current_price:   price
        }]);

        const { data: offers } = await supabase.from("offers").select("*").eq("order_id", String(taskId));
        const buttons = offers.map(o => [{ text: `${o.runner_name} - ₦${o.current_price}`, callback_data: `view_${o.id}` }]);
        buttons.push([{ text: "❌ Cancel Request", callback_data: `cancelreq_${taskId}` }]);

        await bot.sendMessage(order.user_id, "💰 Offers:", { reply_markup: { inline_keyboard: buttons } });
        await bot.sendMessage(userId, `⏳ Offer submitted successfully\n\n💰 Your Offer: ₦${price}\n\nWaiting for the user to accept, counter, or reject your offer.`);
        return bot.answerCallbackQuery(q.id);
      }

      if (kind === "ucounter") {
        const offer = await getOffer(refId);
        if (!offer)                    return denyCallback(q, "❌ Offer not found");
        if (offer.user_id !== userId)  return denyCallback(q);

        await supabase.from("offers").update({ current_price: price }).eq("id", refId);
        await bot.sendMessage(offer.runner_id, `💬 User countered your offer\n\n💰 New price: ₦${price}`, offerButtons(refId, true));
        return bot.answerCallbackQuery(q.id);
      }

      if (kind === "rcounter") {
        const offer = await getOffer(refId);
        if (!offer)                     return denyCallback(q, "❌ Offer not found");
        if (offer.runner_id !== userId) return denyCallback(q);

        await supabase.from("offers").update({ current_price: price }).eq("id", refId);
        await bot.sendMessage(offer.user_id, `💬 Runner updated the offer\n\n💰 New price: ₦${price}`, offerButtons(refId, false));
        return bot.answerCallbackQuery(q.id);
      }

      return denyCallback(q, "❌ Unknown price action");
    }

    // VIEW OFFER
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];
      const o  = await getOffer(id);
      if (!o)                   return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId) return denyCallback(q);

      await bot.sendMessage(userId, `${o.runner_name} - ₦${o.current_price}`, offerButtons(id, false));
      return bot.answerCallbackQuery(q.id);
    }

    // USER COUNTER
    if (data.startsWith("counter_") && !data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[1];
      const o       = await getOffer(offerId);
      if (!o)                   return denyCallback(q, "❌ Offer not found");
      if (o.user_id !== userId) return denyCallback(q);

      await sendPriceAdjuster(userId, Number(o.current_price), "ucounter", offerId);
      return bot.answerCallbackQuery(q.id);
    }

    // RUNNER COUNTER
    if (data.startsWith("counter_runner_")) {
      const offerId = data.split("_")[2];
      const o       = await getOffer(offerId);
      if (!o)                     return denyCallback(q, "❌ Offer not found");
      if (o.runner_id !== userId) return denyCallback(q);

      await sendPriceAdjuster(userId, Number(o.current_price), "rcounter", offerId);
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
      const printCost    = Number(order.print_cost || 0);
      const foodCost     = Number(order.food_cost || 0);
      const userPrice    = Math.round(runnerFee * 1.3) + printCost + foodCost;

      await supabase.from("orders").update({
        runner_id:       o.runner_id,
        runner_username: o.runner_username,
        agreed_price:    runnerFee,
        runner_payout:   runnerPayout,
        total_price:     userPrice,
        status:          "matched",
        payment_status:  "pending"
      }).eq("id", Number(o.order_id));

      await supabase.from("offers").delete().eq("order_id", String(o.order_id));
      clearPendingState(o.user_id);
      clearPendingState(o.runner_id);

      const link            = `${PAYMENT_BASE_URL}/create-payment?orderId=${o.order_id}`;
      const includes = [];
      if (printCost > 0) includes.push(`${formatNaira(printCost)} printing`);
      if (foodCost > 0)  includes.push(`${formatNaira(foodCost)} food`);
      const priceBreakdown = includes.length ? ` (includes ${includes.join(" + ")})` : "";

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

    // CANCEL OPEN REQUEST
    if (data.startsWith("cancelreq_")) {
      const orderId = data.split("_")[1];
      const order   = await getOrder(orderId);
      if (!order)                    return denyCallback(q, "❌ Request not found");
      if (order.user_id !== userId)  return denyCallback(q);
      if (order.status !== "open")   return denyCallback(q, "❌ This request already has a Helper assigned — use the Cancel Task button instead.");

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
      const id    = data.split("_")[1];
      const order = await getOrder(id);
      if (!order)                                             return denyCallback(q, "❌ Order not found");
      if (order.user_id !== userId && order.runner_id !== userId) return denyCallback(q);
      if (order.payment_status === "paid")                    return denyCallback(q, "❌ Cannot cancel after payment");

      const cancellerIsRunner = order.runner_id === userId;
      await supabase.from("offers").delete().eq("order_id", String(id));

      if (cancellerIsRunner) {
        await supabase.from("orders").update({
          runner_id:       null,
          runner_username: null,
          agreed_price:    null,
          runner_payout:   null,
          total_price:     null,
          status:          "open",
          payment_status:  "pending"
        }).eq("id", Number(id));

        await bot.sendMessage(
          RUNNER_GROUP_ID,
          `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n\n📦 Request:\n${order.request_text}\n\n📍 Location:\n${order.delivery_location}${order.food_cost ? `\n\n🍽 Food total: ${formatNaira(order.food_cost)}` : ""}`,
          {
            message_thread_id: GIGS_TOPIC_ID,
            reply_markup: { inline_keyboard: [[{ text: "💰 Make an offer", callback_data: `offer_${order.id}` }]] }
          }
        );

        await bot.sendMessage(order.user_id,   "⚠️ Your Helper cancelled the task.\n\nYour request has been reposted.");
        await bot.sendMessage(order.runner_id,  "❌ You cancelled the task.");
      } else {
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
      const id    = data.split("_")[1];
      const order = await getOrder(id);
      if (!order)                                             return denyCallback(q, "❌ Task not found");
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
      // query may be too old; nothing more to do
    }
  }
});

// ================= PRINTER =================

// Turns Telegram's error into something a human can act on.
function explainPrinterError(err) {
  const msg = String((err && err.message) || err || "");
  if (/blocked by the user/i.test(msg))          return "The printer has blocked the bot. Ask them to unblock it in Telegram.";
  if (/user is deactivated/i.test(msg))          return "The printer's Telegram account is deactivated.";
  if (/can't initiate conversation/i.test(msg))  return "The printer hasn't started the bot yet. Ask them to open the Helply bot in Telegram and tap Start (they don't need to finish sign-up), then try again.";
  if (/chat not found/i.test(msg))               return "Telegram can't find that chat ID. Check it's the printer's numeric Telegram ID, and that they've opened the bot and tapped Start.";
  if (/wrong file identifier|wrong remote file/i.test(msg)) return "Telegram no longer accepts that file. Ask the student to send the document again.";
  return msg || "Unknown Telegram error.";
}

// Sends a paid print job (details + the file) to the printer's Telegram chat.
// Returns { ok: true } or { ok: false, reason } and never throws.
async function sendPrintJobToPrinter(order) {
  const colorLabel = order.print_color === "color" ? "Color" : "Black & White";
  const caption =
    `🖨️ Paid print job #${order.id}\n\n${order.print_pages} page(s)\n${colorLabel}\nPaper: ${order.print_paper}\n` +
    `Binding: ${order.print_binding ? "Yes" : "No"}${order.print_note ? `\nNote: ${order.print_note}` : ""}`;

  try {
    if (order.print_file_type === "document") {
      await bot.sendDocument(PRINTER_CHAT_ID, order.print_file_id, { caption });
    } else {
      await bot.sendPhoto(PRINTER_CHAT_ID, order.print_file_id, { caption });
    }
    return { ok: true };
  } catch (err) {
    console.log("PRINTER NOTIFY ERROR:", err.message);
    return { ok: false, reason: explainPrinterError(err) };
  }
}

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

      await supabase.from("orders").update({ payment_status: "paid", status: "in_progress" }).eq("id", orderId);

      await bot.sendMessage(
        order.runner_id,
        `💰 Payment received!\n\n📦 Task is now active.${order.food_cost ? `\n\n🍽 Food to buy (${formatNaira(order.food_cost)}):\n${order.request_text}` : ""}\n\n💬 You can now chat with the user — just type any message here and it'll be sent to them.`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
      ).catch(err => console.log("WEBHOOK DM ERROR:", err.message));
      await bot.sendMessage(
        order.user_id,
        "✅ Payment confirmed!\n\n🤝 You can now chat with your Helper — just type any message here and it'll be sent to them.",
        { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
      ).catch(err => console.log("WEBHOOK DM ERROR:", err.message));

      // Printing: now that payment is confirmed, send the file to the printer.
      if (order.category === "Printing" && order.print_file_id) {
        const sent = await sendPrintJobToPrinter(order);
        if (!sent.ok) {
          console.log(`PRINT JOB #${orderId} NOT DELIVERED TO PRINTER: ${sent.reason}`);
          await bot.sendMessage(
            order.runner_id,
            `⚠️ We couldn't send the print file to the printer automatically (Request ID: ${orderId}). Please contact ${SUPPORT_EMAIL} and we'll sort it out.`
          ).catch(() => {});
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Helply Admin</title>
<style>
:root{
  --bg:#0d0d0d;--card:#141210;--card2:#1a1714;--border:#2a2420;
  --text:#fff;--muted:#a89888;--orange:#FF6A13;
  --green:#4ade80;--red:#f87171;--yellow:#f5c542;--blue:#60a5fa;--purple:#a78bfa;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:2px solid var(--orange);position:sticky;top:0;z-index:100;background:var(--bg)}
.logo{font-size:18px;font-weight:700}.logo span{color:var(--orange)}
.hdr-right{display:flex;gap:8px;align-items:center}
nav{display:flex;gap:2px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--card);overflow-x:auto}
.tab{padding:12px 16px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tab:hover{color:var(--text)}.tab.active{color:var(--orange);border-bottom-color:var(--orange)}
.page{display:none;padding:24px;max-width:1100px;margin:0 auto}.page.active{display:block}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.stat-card .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}
.stat-card .val{font-size:22px;font-weight:700}.stat-card .sub{font-size:11px;color:var(--muted);margin-top:4px}
.stat-card.orange .val{color:var(--orange)}.stat-card.green .val{color:var(--green)}
.stat-card.blue .val{color:var(--blue)}.stat-card.purple .val{color:var(--purple)}
.section{margin-bottom:28px}
.section-title{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:700;margin-bottom:10px}
.filter-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filter-bar input,.filter-bar select{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit}
.filter-bar input{flex:1;min-width:160px}.filter-bar select{min-width:130px}
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;background:var(--card);font-size:13px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:600;background:var(--card2)}
tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#1f1a17;cursor:pointer}
.empty{color:var(--muted);padding:24px;text-align:center;font-size:13px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.badge.open{background:rgba(245,197,66,.15);color:var(--yellow)}
.badge.matched{background:rgba(255,106,19,.15);color:var(--orange)}
.badge.in_progress{background:rgba(74,222,128,.15);color:var(--green)}
.badge.completed{background:rgba(96,165,250,.15);color:var(--blue)}
.badge.cancelled,.badge.voided,.badge.refunded{background:rgba(248,113,113,.15);color:var(--red)}
.badge.food_runs,.badge.food{background:rgba(245,197,66,.12);color:var(--yellow)}
.badge.laundry{background:rgba(96,165,250,.12);color:var(--blue)}
.badge.printing{background:rgba(167,139,250,.12);color:var(--purple)}
.badge.errands,.badge.other{background:rgba(74,222,128,.12);color:var(--green)}
.badge.paid{background:rgba(74,222,128,.15);color:var(--green)}
.badge.pending{background:rgba(255,106,19,.15);color:var(--orange)}
button{font:inherit;cursor:pointer;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600}
.btn-orange{background:var(--orange);color:#fff}.btn-green{background:var(--green);color:#000}
.btn-red{background:var(--red);color:#fff}.btn-blue{background:var(--blue);color:#000}
.btn-purple{background:var(--purple);color:#000}.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.icon-btn{padding:4px 10px;font-size:12px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;padding:16px;z-index:200}
.overlay.show{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto}
.modal h3{font-size:16px;margin-bottom:16px}
.mrow{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--border)}
.mrow:last-of-type{border-bottom:none}.mrow .lbl{color:var(--muted)}
.mclose{float:right;background:none;color:var(--muted);font-size:18px;padding:0 4px;cursor:pointer}
input[type=text],textarea{width:100%;padding:8px 10px;background:#0d0d0d;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;font-family:inherit;margin-bottom:8px}
textarea{resize:vertical;min-height:80px}
.ifrm{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.ifrm input{flex:1;min-width:140px;margin-bottom:0}
.bc-item{background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:8px;font-size:13px}
.bc-meta{color:var(--muted);font-size:11px;margin-top:4px}
.toast{position:fixed;bottom:20px;right:20px;background:var(--card);border:1px solid var(--border);padding:12px 16px;border-radius:10px;font-size:13px;display:none;z-index:999;max-width:340px}
.toast.show{display:block}
</style>
</head>
<body>
<header>
  <div class="logo">Helply <span>Admin</span></div>
  <div class="hdr-right">
    <span style="font-size:11px;color:var(--muted)" id="lastRefresh"></span>
    <button class="btn-ghost" onclick="refreshCurrent()">&#8635; Refresh</button>
  </div>
</header>
<nav id="navBar">
  <div class="tab active" onclick="switchTab('overview')">&#128202; Overview</div>
  <div class="tab" onclick="switchTab('orders')">&#128230; Orders</div>
  <div class="tab" onclick="switchTab('users')">&#128101; Users</div>
  <div class="tab" onclick="switchTab('helpers')">&#127939; Helpers</div>
  <div class="tab" onclick="switchTab('printing')">&#128424; Printing</div>
  <div class="tab" onclick="switchTab('broadcast')">&#128226; Broadcast</div>
  <div class="tab" onclick="switchTab('settings')">&#9881; Settings</div>
</nav>

<div class="page active" id="page-overview">
  <div class="stats-grid" id="statsGrid"><div class="empty">Loading...</div></div>
  <div class="section">
    <div class="section-title">Recent Orders</div>
    <div class="tbl-wrap"><div id="recentOrders"><div class="empty">Loading...</div></div></div>
  </div>
</div>

<div class="page" id="page-orders">
  <div class="filter-bar">
    <input type="text" id="orderSearch" placeholder="Search name, ID, request..." oninput="filterOrders()">
    <select id="orderStatus" onchange="filterOrders()">
      <option value="">All statuses</option>
      <option value="open">Open</option>
      <option value="matched">Matched</option>
      <option value="in_progress">In Progress</option>
      <option value="completed">Completed</option>
      <option value="cancelled">Cancelled</option>
      <option value="voided">Voided</option>
    </select>
    <select id="orderCategory" onchange="filterOrders()">
      <option value="">All categories</option>
      <option value="Food Runs">Food Runs</option>
      <option value="Laundry">Laundry</option>
      <option value="Printing">Printing</option>
      <option value="Errands">Errands</option>
    </select>
  </div>
  <div class="tbl-wrap"><div id="ordersTable"><div class="empty">Loading...</div></div></div>
</div>

<div class="page" id="page-users">
  <div class="filter-bar">
    <input type="text" id="userSearch" placeholder="Search name, email, phone..." oninput="filterUsers()">
    <select id="userFilter" onchange="filterUsers()">
      <option value="">All users</option>
      <option value="banned">Banned only</option>
      <option value="active">Active only</option>
    </select>
  </div>
  <div class="tbl-wrap"><div id="usersTable"><div class="empty">Loading...</div></div></div>
  <div style="margin-top:20px">
    <div class="section-title">Ban a user by Telegram ID</div>
    <div class="ifrm">
      <input type="text" id="banUserId" placeholder="Telegram user ID">
      <input type="text" id="banReason" placeholder="Reason (optional)">
      <button class="btn-red" onclick="banUser()">Ban</button>
    </div>
  </div>
</div>

<div class="page" id="page-helpers">
  <div class="tbl-wrap"><div id="helpersTable"><div class="empty">Loading...</div></div></div>
</div>

<div class="page" id="page-printing">
  <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
    <button class="btn-blue" onclick="testPrinter()">&#128424; Test printer connection</button>
    <span style="font-size:12px;color:var(--muted)">Printer ID: ${PRINTER_CHAT_ID}</span>
  </div>
  <div class="tbl-wrap"><div id="printTable"><div class="empty">Loading...</div></div></div>
</div>

<div class="page" id="page-broadcast">
  <div class="section">
    <div class="section-title">Send message to all users</div>
    <textarea id="broadcastMsg" placeholder="Type your message here..."></textarea>
    <button class="btn-purple" onclick="sendBroadcast()">&#128226; Send to all users</button>
  </div>
  <div id="broadcastHistory"></div>
</div>

<div class="page" id="page-settings">
  <div class="section">
    <div class="section-title">Printer</div>
    <div class="mrow"><span class="lbl">Printer Telegram ID</span><span>${PRINTER_CHAT_ID}</span></div>
    <div class="btn-row"><button class="btn-blue" onclick="testPrinter()">&#128424; Send test message</button></div>
  </div>
</div>

<div class="overlay" id="overlay"><div class="modal" id="modalBody"></div></div>
<div class="toast" id="toast"></div>

<script>
var allOrders=[], allUsers=[], currentTab="overview";
var TABS=["overview","orders","users","helpers","printing","broadcast","settings"];

function $(id){return document.getElementById(id)}
async function api(path,opts){
  var res=await fetch(path,Object.assign({headers:{"Content-Type":"application/json"}},opts));
  if(!res.ok) throw new Error((await res.json().catch(function(){return{}})).error||res.statusText);
  return res.json();
}
function toast(msg){var el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(function(){el.classList.remove("show")},3500)}
function naira(n){return"\\u20a6"+Number(n||0).toLocaleString("en-NG")}
function ago(ts){if(!ts)return"--";var s=Math.floor((Date.now()-new Date(ts))/1000);if(s<60)return s+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}
function closeModal(){$("overlay").classList.remove("show")}
function bdg(val,cls){return"<span class='badge "+(cls||String(val||"").toLowerCase().replace(/ /g,"_"))+"'>"+val+"</span>"}
function catBdg(cat){var c=(cat||"other").toLowerCase().replace(/ /g,"_");var m={"food_runs":"food_runs","food":"food_runs","laundry":"laundry","printing":"printing","errands":"errands"};return"<span class='badge "+(m[c]||"other")+"'>"+(cat||"Other")+"</span>"}

function switchTab(name){
  currentTab=name;
  TABS.forEach(function(t,i){
    $("page-"+t).classList.toggle("active",t===name);
    document.querySelectorAll(".tab")[i].classList.toggle("active",t===name);
  });
  refreshCurrent();
}

function refreshCurrent(){
  $("lastRefresh").textContent="Updated "+new Date().toLocaleTimeString();
  if(currentTab==="overview"){loadStats();loadRecentOrders();}
  else if(currentTab==="orders")   loadOrders();
  else if(currentTab==="users")    loadUsers();
  else if(currentTab==="helpers")  loadHelpers();
  else if(currentTab==="printing") loadPrinting();
  else if(currentTab==="broadcast")loadBroadcastHistory();
}
setInterval(function(){if(currentTab==="overview"||currentTab==="orders")refreshCurrent();},60000);

async function loadStats(){
  $("statsGrid").innerHTML="<div class='empty'>Loading...</div>";
  try{
    var d=await api("/admin/api/stats");
    $("statsGrid").innerHTML=[
      ["Total Users",    d.totalUsers,       "blue",  "all time"],
      ["Active Orders",  d.activeOrders,     "orange","open + in progress"],
      ["Done Today",     d.completedToday,   "green", "completed today"],
      ["Revenue Today",  naira(d.revenueToday),  "orange","Helply cut today"],
      ["Revenue Week",   naira(d.revenueWeek),   "green", "this week"],
      ["Revenue Month",  naira(d.revenueMonth),  "green", "this month"],
      ["Top Category",   d.topCategory||"--","purple","by completed orders"],
      ["Active Helpers", d.activeHelpers,    "blue",  "completed >= 1 task"],
    ].map(function(r){return"<div class='stat-card "+r[2]+"'><div class='lbl'>"+r[0]+"</div><div class='val'>"+r[1]+"</div><div class='sub'>"+r[3]+"</div></div>"}).join("");
  }catch(e){$("statsGrid").innerHTML="<div class='empty'>Error: "+e.message+"</div>";}
}

async function loadRecentOrders(){
  $("recentOrders").innerHTML="<div class='empty'>Loading...</div>";
  try{var d=await api("/admin/api/orders?limit=8");renderOrderTbl(d.orders,"recentOrders",true);}
  catch(e){$("recentOrders").innerHTML="<div class='empty'>Error: "+e.message+"</div>";}
}

async function loadOrders(){
  $("ordersTable").innerHTML="<div class='empty'>Loading...</div>";
  try{var d=await api("/admin/api/orders?limit=200");allOrders=d.orders;filterOrders();}
  catch(e){$("ordersTable").innerHTML="<div class='empty'>Error: "+e.message+"</div>";}
}
function filterOrders(){
  var q=($("orderSearch")||{value:""}).value.toLowerCase();
  var st=($("orderStatus")||{value:""}).value;
  var cat=($("orderCategory")||{value:""}).value;
  var f=allOrders.filter(function(o){
    return(!st||o.status===st)&&(!cat||(o.category||"")===cat)&&
    (!q||[o.id,o.requester_name,o.helper_name,o.request_text].join(" ").toLowerCase().includes(q));
  });
  renderOrderTbl(f,"ordersTable",false);
}
function renderOrderTbl(orders,id,mini){
  if(!orders||!orders.length){$(id).innerHTML="<div class='empty'>No orders found.</div>";return;}
  var h="<table><thead><tr><th>ID</th><th>Status</th><th>Category</th><th>Requester</th><th>Helper</th>"+(mini?"":"<th>Request</th>")+"<th>Total</th><th>Created</th></tr></thead><tbody>";
  orders.forEach(function(o){
    var req=o.requester_name||("@"+(o.user_username||"unknown"));
    var hlp=o.helper_name||(o.runner_username?"@"+o.runner_username:"--");
    h+="<tr data-id='"+o.id+"' onclick='openOrder(this.dataset.id)'><td>#"+o.id+"</td><td>"+bdg(o.status)+"</td><td>"+catBdg(o.category)+"</td><td>"+req+"</td><td>"+hlp+"</td>"+(mini?"":"<td style='max-width:180px;white-space:normal'>"+(o.request_text||"--").slice(0,80)+"</td>")+"<td>"+naira(o.total_price)+"</td><td>"+ago(o.created_at)+"</td></tr>";
  });
  h+="</tbody></table>";
  $(id).innerHTML=h;
}

async function loadUsers(){
  $("usersTable").innerHTML="<div class='empty'>Loading...</div>";
  try{var d=await api("/admin/api/users");allUsers=d.users;filterUsers();}
  catch(e){$("usersTable").innerHTML="<div class='empty'>Error: "+e.message+"</div>";}
}
function filterUsers(){
  var q=($("userSearch")||{value:""}).value.toLowerCase();
  var f=($("userFilter")||{value:""}).value;
  var list=allUsers.filter(function(u){
    return(!f||(f==="banned"?u.banned:!u.banned))&&(!q||[u.full_name,u.email,u.phone,u.username,u.id].join(" ").toLowerCase().includes(q));
  });
  if(!list.length){$("usersTable").innerHTML="<div class='empty'>No users found.</div>";return;}
  var h="<table><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Phone</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>";
  list.forEach(function(u){
    h+="<tr><td>"+(u.full_name||"--")+"</td><td>"+(u.username?"@"+u.username:"--")+"</td><td>"+(u.email||"--")+"</td><td>"+(u.phone||"--")+"</td><td>"+ago(u.created_at)+"</td><td>"+(u.banned?bdg("Banned","voided"):bdg("Active","in_progress"))+"</td><td>"+(u.banned?"<button class='btn-ghost icon-btn' onclick='unbanUser(\\""+u.id+"\\")'>Unban</button>":"<button class='btn-red icon-btn' onclick='quickBan(\\""+u.id+"\\")'>Ban</button>")+"</td></tr>";
  });
  h+="</tbody></table>";$("usersTable").innerHTML=h;
}
async function quickBan(uid){
  var r=prompt("Ban reason (leave blank to skip):");if(r===null)return;
  try{await api("/admin/api/users/"+uid+"/ban",{method:"POST",body:JSON.stringify({reason:r||null})});toast("User banned");loadUsers();}
  catch(e){toast("Error: "+e.message);}
}
async function banUser(){
  var uid=$("banUserId").value.trim(),reason=$("banReason").value.trim();
  if(!uid)return toast("Enter a user ID");
  try{await api("/admin/api/users/"+uid+"/ban",{method:"POST",body:JSON.stringify({reason:reason||null})});toast("User "+uid+" banned");$("banUserId").value="";$("banReason").value="";loadUsers();}
  catch(e){toast("Error: "+e.message);}
}
async function unbanUser(uid){
  try{await api("/admin/api/users/"+uid+"/unban",{method:"POST"});toast("Unbanned");loadUsers();}
  catch(e){toast("Error: "+e.message);}
}

async function loadHelpers(){
  $("helpersTable").innerHTML="<div class='empty'>Loading...</div>";
  try{
    var d=await api("/admin/api/helpers");
    if(!d.helpers.length){$("helpersTable").innerHTML="<div class='empty'>No Helpers have completed a task yet.</div>";return;}
    var h="<table><thead><tr><th>Name</th><th>Username</th><th>Tasks Done</th><th>Total Earned</th><th>Last Active</th></tr></thead><tbody>";
    d.helpers.forEach(function(hh){h+="<tr><td>"+(hh.full_name||"--")+"</td><td>"+(hh.username?"@"+hh.username:"--")+"</td><td>"+hh.tasks_completed+"</td><td>"+naira(hh.total_earned)+"</td><td>"+ago(hh.last_active)+"</td></tr>";});
    h+="</tbody></table>";$("helpersTable").innerHTML=h;
  }catch(e){$("helpersTable").innerHTML="<div class='empty'>Error: "+e.message+"</div>";}
}

async function loadPrinting(){
  $("printTable").innerHTML="<div class='empty'>Loading...</div>";
  try{
    var d=await api("/admin/api/printing");
    if(!d.orders.length){$("printTable").innerHTML="<div class='empty'>No print orders yet.</div>";return;}
    var h="<table><thead><tr><th>ID</th><th>Status</th><th>Requester</th><th>Pages</th><th>Color</th><th>Paper</th><th>Binding</th><th>Payment</th><th>Created</th><th></th></tr></thead><tbody>";
    d.orders.forEach(function(o){
      var paid=o.payment_status==="paid";
      h+="<tr><td>#"+o.id+"</td><td>"+bdg(o.status)+"</td><td>"+(o.requester_name||"--")+"</td><td>"+(o.print_pages||"--")+"</td><td>"+(o.print_color==="color"?"Color":"B&W")+"</td><td>"+(o.print_paper||"--")+"</td><td>"+(o.print_binding?"Yes":"No")+"</td><td>"+(paid?bdg("Paid","paid"):bdg("Pending","pending"))+"</td><td>"+ago(o.created_at)+"</td><td>"+(paid?"<button class='btn-purple icon-btn' onclick='resendPrinter("+o.id+")'>Resend</button>":"")+"</td></tr>";
    });
    h+="</tbody></table>";$("printTable").innerHTML=h;
  }catch(e){$("printTable").innerHTML="<div class='empty'>Error: "+e.message+"</div>";}
}
async function testPrinter(){
  try{await api("/admin/api/printer/test",{method:"POST"});toast("Test message sent — check the printer Telegram");}
  catch(e){alert("Printer test failed: "+e.message);}
}
async function resendPrinter(id){
  if(!confirm("Resend this print job to the printer?"))return;
  try{await api("/admin/api/orders/"+id+"/resend-printer",{method:"POST"});toast("Sent to printer");}
  catch(e){alert("Could not send: "+e.message);}
}

async function openOrder(id){
  try{
    var o=(await api("/admin/api/orders/"+id)).order;
    var req=o.requester_name||("@"+(o.user_username||o.user_id));
    var hlp=o.helper_name||(o.runner_username?"@"+o.runner_username:"unassigned");
    var rows=[
      ["Status",       bdg(o.status)+" / "+bdg(o.payment_status||"pending")],
      ["Category",     catBdg(o.category)],
      ["Requester",    req+"<small style='color:var(--muted);margin-left:6px'>"+o.user_id+"</small>"],
      ["Helper",       hlp+(o.runner_id?"<small style='color:var(--muted);margin-left:6px'>"+o.runner_id+"</small>":"")],
      ["Request",      "<span style='white-space:normal'>"+(o.request_text||"--")+"</span>"],
      ["Location",     o.delivery_location||"--"],
      ["Agreed fee",   naira(o.agreed_price)],
    ];
    if(o.food_cost)  rows.push(["Food cost",   naira(o.food_cost)]);
    if(o.print_cost) rows.push(["Print cost",  naira(o.print_cost)]);
    rows.push(["Helper payout", naira(o.runner_payout)]);
    rows.push(["Student pays",  naira(o.total_price)]);
    rows.push(["Created",       o.created_at?new Date(o.created_at).toLocaleString():"--"]);
    var btns=[];
    if(o.status!=="completed") btns.push("<button class='btn-green' onclick='resolveOrder("+id+",\\"complete\\")'>Force complete</button>");
    if(o.status==="matched"||o.status==="in_progress") btns.push("<button class='btn-orange' onclick='resolveOrder("+id+",\\"reset\\")'>Reset to open</button>");
    if(o.payment_status==="paid") btns.push("<button class='btn-orange' onclick='resolveOrder("+id+",\\"refund\\")'>Mark refunded</button>");
    btns.push("<button class='btn-red' onclick='resolveOrder("+id+",\\"void\\")'>Void</button>");
    btns.push("<button class='btn-ghost' onclick='quickBan(\\""+o.user_id+"\\")'>Ban requester</button>");
    if(o.runner_id) btns.push("<button class='btn-ghost' onclick='quickBan(\\""+o.runner_id+"\\")'>Ban helper</button>");
    if(o.category==="Printing"&&o.payment_status==="paid") btns.push("<button class='btn-purple' onclick='resendPrinter("+id+")'>Resend to printer</button>");
    $("modalBody").innerHTML="<button class='mclose' onclick='closeModal()'>x</button><h3>Order #"+o.id+"</h3>"+rows.map(function(r){return"<div class='mrow'><span class='lbl'>"+r[0]+"</span><span>"+r[1]+"</span></div>"}).join("")+"<div class='btn-row'>"+btns.join("")+"</div>";
    $("overlay").classList.add("show");
  }catch(e){toast("Error: "+e.message);}
}
async function resolveOrder(id,action){
  try{await api("/admin/api/orders/"+id+"/"+action,{method:"POST"});toast("Order #"+id+" updated ("+action+")");closeModal();refreshCurrent();}
  catch(e){toast("Error: "+e.message);}
}

async function loadBroadcastHistory(){
  try{
    var d=await api("/admin/api/broadcasts");
    if(!d.broadcasts.length){$("broadcastHistory").innerHTML="";return;}
    var h="<div class='section-title' style='margin:16px 0 8px'>Recent broadcasts</div>";
    d.broadcasts.forEach(function(b){h+="<div class='bc-item'>"+b.message+"<div class='bc-meta'>"+new Date(b.created_at).toLocaleString()+" - "+(b.sent_count||"?")+" recipients</div></div>";});
    $("broadcastHistory").innerHTML=h;
  }catch(e){}
}
async function sendBroadcast(){
  var msg=$("broadcastMsg").value.trim();
  if(!msg)return toast("Type a message first");
  if(!confirm("Send to ALL users?"))return;
  try{var d=await api("/admin/api/broadcast",{method:"POST",body:JSON.stringify({message:msg})});toast("Sent to "+d.sent+" users"+(d.failed>0?" ("+d.failed+" failed)":""));$("broadcastMsg").value="";loadBroadcastHistory();}
  catch(e){toast("Error: "+e.message);}
}

loadStats();loadRecentOrders();
</script>
</body>
</html>
`;

app.get("/admin", (req, res) => res.send(DASHBOARD_HTML));

app.get("/admin/api/orders", async (req, res) => {
  const limit  = Math.min(Number(req.query.limit) || 50, 500);
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, status, payment_status, user_id, user_username, runner_id, runner_username, total_price, agreed_price, runner_payout, food_cost, print_cost, request_text, delivery_location, category, created_at")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Attach real names from the users table
  const userIds = [...new Set([
    ...(orders||[]).map(o => o.user_id).filter(Boolean),
    ...(orders||[]).map(o => o.runner_id).filter(Boolean)
  ])];
  let nameMap = {};
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, username").in("id", userIds);
    (users || []).forEach(u => { nameMap[u.id] = u.full_name || null; });
  }
  const enriched = (orders || []).map(o => ({
    ...o,
    requester_name: nameMap[o.user_id] || null,
    helper_name:    nameMap[o.runner_id] || null,
  }));
  return res.json({ orders: enriched });
});

app.get("/admin/api/orders/:id", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  const ids = [order.user_id, order.runner_id].filter(Boolean);
  let nameMap = {};
  if (ids.length) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", ids);
    (users || []).forEach(u => { nameMap[u.id] = u.full_name || null; });
  }
  return res.json({ order: { ...order, requester_name: nameMap[order.user_id] || null, helper_name: nameMap[order.runner_id] || null } });
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
      `🚨 REPOSTED REQUEST\n\n🆔 ${order.id}\n\n📦 Request:\n${order.request_text}\n\n📍 Location:\n${order.delivery_location}${order.food_cost ? `\n\n🍽 Food total: ${formatNaira(order.food_cost)}` : ""}`,
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

app.get("/admin/api/users", async (req, res) => {
  const { data: users, error } = await supabase
    .from("users")
    .select("id, username, full_name, email, phone, banned, ban_reason, accepted_terms, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ users: users || [] });
});

app.get("/admin/api/users/banned", async (req, res) => {
  const { data: users, error } = await supabase.from("users").select("id, username, full_name, ban_reason").eq("banned", true);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

app.get("/admin/api/helpers", async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select("runner_id, runner_payout, created_at")
      .eq("status", "completed")
      .not("runner_id", "is", null);
    if (error) return res.status(500).json({ error: error.message });

    // Group by runner
    const map = {};
    (orders || []).forEach(o => {
      if (!map[o.runner_id]) map[o.runner_id] = { tasks: 0, earned: 0, last: null };
      map[o.runner_id].tasks++;
      map[o.runner_id].earned += Number(o.runner_payout || 0);
      if (!map[o.runner_id].last || o.created_at > map[o.runner_id].last) map[o.runner_id].last = o.created_at;
    });

    const ids = Object.keys(map);
    let nameMap = {};
    if (ids.length) {
      const { data: users } = await supabase.from("users").select("id, username, full_name").in("id", ids);
      (users || []).forEach(u => { nameMap[u.id] = u; });
    }

    const helpers = ids.map(id => ({
      id,
      username:        (nameMap[id] || {}).username || null,
      full_name:       (nameMap[id] || {}).full_name || null,
      tasks_completed: map[id].tasks,
      total_earned:    map[id].earned,
      last_active:     map[id].last
    })).sort((a, b) => b.tasks_completed - a.tasks_completed);

    return res.json({ helpers });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Stats ──────────────────────────────────────────────────────────────────

app.get("/admin/api/stats", async (req, res) => {
  try {
    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);
    const weekAgo   = new Date(now - 7  * 86400000).toISOString();
    const monthAgo  = new Date(now - 30 * 86400000).toISOString();

    const [usersRes, ordersRes, completedRes] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }),
      supabase.from("orders").select("status").in("status", ["open", "matched", "in_progress"]),
      supabase.from("orders").select("runner_payout, agreed_price, total_price, category, created_at, runner_id")
        .eq("status", "completed")
    ]);

    const completed = completedRes.data || [];

    const todayCompleted  = completed.filter(o => o.created_at && o.created_at.startsWith(todayStr));
    const weekCompleted   = completed.filter(o => o.created_at && o.created_at >= weekAgo);
    const monthCompleted  = completed.filter(o => o.created_at && o.created_at >= monthAgo);

    // Helply cut = total_price - runner_payout (payout already computed at 90% of agreed_price)
    const cut = rows => rows.reduce((s, o) => s + Math.max(0, Number(o.total_price || 0) - Number(o.runner_payout || 0)), 0);

    // Category counts
    const catCounts = {};
    completed.forEach(o => { const c = o.category || "Other"; catCounts[c] = (catCounts[c] || 0) + 1; });
    const topCategory = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "--";

    // Active helpers = distinct runner_ids in completed orders
    const activeHelpers = new Set(completed.map(o => o.runner_id).filter(Boolean)).size;

    return res.json({
      totalUsers:     usersRes.count || 0,
      activeOrders:   (ordersRes.data || []).length,
      completedToday: todayCompleted.length,
      revenueToday:   cut(todayCompleted),
      revenueWeek:    cut(weekCompleted),
      revenueMonth:   cut(monthCompleted),
      topCategory,
      activeHelpers
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Printing jobs ──────────────────────────────────────────────────────────

app.get("/admin/api/printing", async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, status, payment_status, user_id, user_username, print_pages, print_color, print_paper, print_binding, print_note, print_file_id, created_at")
      .eq("category", "Printing")
      .order("id", { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    const ids = [...new Set((orders || []).map(o => o.user_id).filter(Boolean))];
    let nameMap = {};
    if (ids.length) {
      const { data: users } = await supabase.from("users").select("id, full_name").in("id", ids);
      (users || []).forEach(u => { nameMap[u.id] = u.full_name || null; });
    }
    return res.json({ orders: (orders || []).map(o => ({ ...o, requester_name: nameMap[o.user_id] || null })) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Broadcast ─────────────────────────────────────────────────────────────────

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

    let sent = 0, failed = 0;
    for (const user of (users || [])) {
      try {
        await bot.sendMessage(user.id, `📢 *Helply Update*\n\n${message}`, { parse_mode: "Markdown" });
        sent++;
      } catch (e) {
        console.log(`BROADCAST FAILED for ${user.id}:`, e.message);
        failed++;
      }
    }

    await supabase.from("broadcasts").insert([{ message, sent_count: sent }]);
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

// ── Printer ───────────────────────────────────────────────────────────────────

app.post("/admin/api/printer/test", async (req, res) => {
  try {
    await bot.sendMessage(PRINTER_CHAT_ID, "🖨️ Test from Helply — if you can see this, paid print jobs will reach you here.");
    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "printer_test", { note: `chat ${PRINTER_CHAT_ID}` });
    return res.json({ ok: true });
  } catch (err) {
    console.log("PRINTER TEST ERROR:", err.message);
    return res.status(400).json({ error: explainPrinterError(err) });
  }
});

app.post("/admin/api/orders/:id/resend-printer", async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.category !== "Printing" || !order.print_file_id) return res.status(400).json({ error: "This isn't a print order with a file." });
    if (order.payment_status !== "paid") return res.status(400).json({ error: "This order hasn't been paid for yet." });

    const sent = await sendPrintJobToPrinter(order);
    if (!sent.ok) return res.status(400).json({ error: sent.reason });

    await logAdminAction(`dashboard:${req.dashboardAdmin}`, "resend_printer", { orderId: order.id });
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ================= SERVER =================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
