console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY exists:", !!process.env.SUPABASE_KEY);
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

if (!BOT_TOKEN || !RUNNER_GROUP_ID) {
  console.error("❌ Missing BOT_TOKEN or RUNNER_GROUP_ID");
  process.exit(1);
}

// ================= SUPABASE =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log("🤖 Helply bot is running...");

// ================= START =================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.type !== "private") return;

  bot.sendMessage(
    msg.chat.id,
    `👋 *Welcome to Helply*

Send your request in ONE message.

Example:
Buy rice by 12pm, room D401

A trusted runner will accept it.`,
    { parse_mode: "Markdown" }
  );
});

// ================= USER REQUEST =================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const taskText = msg.text;
const taskId = Math.random().toString(36).substring(2, 9);

console.log("INSERTING TASK ID:", taskId);

  const timeMatch = taskText.match(/by ([^,]+)/i);
  const time = timeMatch ? timeMatch[1] : "Not specified";

  const roomMatch = taskText.match(/room ([^,]+)/i);
  const location = roomMatch ? roomMatch[1] : "Not specified";

  // Insert into Supabase
  const { error: insertError } = await supabase
  .from("orders")
  .insert([
    {
      id: taskId,
      user_id: msg.chat.id.toString(),
      task: taskText,
      status: "pending",
      created_at: new Date(),
      updated_at: new Date(),
    },
  ]);

console.log("INSERT ERROR:", insertError);

  // Confirm to user
  bot.sendMessage(
    msg.chat.id,
    `✅ *Task Received*

🆔 Task ID: \`${taskId}\`
⏰ ${time}
📍 ${location}

Waiting for a runner...`,
    { parse_mode: "Markdown" }
  );

  // Send to runner group
  bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 *NEW HELPLY TASK*

🆔 Task ID: \`${taskId}\`
📌 ${taskText}
⏰ ${time}
📍 ${location}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Accept Task",
              callback_data: `accept_${taskId}`,
            },
          ],
        ],
      },
    }
  );
});

// ================= CALLBACK HANDLER =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const runnerName = query.from.first_name;
  const runnerId = query.from.id;

  // ================= ACCEPT =================
  if (data.startsWith("accept_")) {
  const taskId = data.split("_")[1];

  console.log("TASK ID RECEIVED:", taskId);

  // 🔎 Fetch order first
  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*")
    .eq("id", taskId)
    .single();

  console.log("ORDER FROM DB:", order);
  console.log("FETCH ERROR:", fetchError);

  if (fetchError || !order) {
    return bot.answerCallbackQuery(query.id, {
      text: "Task not found",
      show_alert: true,
    });
  }

  if (order.status === "assigned") {
    return bot.answerCallbackQuery(query.id, {
      text: "❌ Task already taken",
      show_alert: true,
    });
  }

  // 🔥 Update without status condition
  const { error: updateError } = await supabase
    .from("orders")
    .update({
      status: "assigned",
      runner_name: runnerName,
      runner_id: runnerId.toString(),
      updated_at: new Date(),
    })
    .eq("id", taskId);

  console.log("UPDATE ERROR:", updateError);

  if (updateError) {
    return bot.answerCallbackQuery(query.id, {
      text: "Update failed",
      show_alert: true,
    });
  }

  // Update group message
  bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }
  );

  bot.editMessageText(
    `${query.message.text}

✅ *Accepted by ${runnerName}*`,
    {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    }
  );

  // Notify user
  bot.sendMessage(
    order.user_id,
    `🎉 *Your task has been accepted!*

👤 Runner: ${runnerName}`,
    { parse_mode: "Markdown" }
  );

  return bot.answerCallbackQuery(query.id, {
    text: "✅ Task assigned",
  });
}

  // ================= CANCEL BUTTON =================
  if (data.startsWith("cancel_")) {
    const taskId = data.split("_")[1];

    bot.sendMessage(
      runnerId,
      `Why are you cancelling Task ${taskId}?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Item unavailable", callback_data: `reason_unavailable_${taskId}` }],
            [{ text: "Personal emergency", callback_data: `reason_emergency_${taskId}` }],
            [{ text: "Too far", callback_data: `reason_distance_${taskId}` }],
          ],
        },
      }
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= CANCEL REASON =================
  if (data.startsWith("reason_")) {
    const parts = data.split("_");
    const reason = parts[1];
    const taskId = parts[2];

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", taskId)
      .single();

    if (!order) return;

    await supabase
      .from("orders")
      .update({
        status: "cancelled",
        cancel_reason: reason,
        updated_at: new Date(),
      })
      .eq("id", taskId);

    bot.sendMessage(
      order.user_id,
      `⚠️ Your task was cancelled.

Reason: ${reason}

Reposting now...`,
      { parse_mode: "Markdown" }
    );

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🔁 *TASK REPOSTED*

🆔 Task ID: \`${taskId}\`
📌 ${order.task}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept Task", callback_data: `accept_${taskId}` }],
          ],
        },
      }
    );

    bot.sendMessage(runnerId, "❌ Task cancelled.");

    return bot.answerCallbackQuery(query.id);
  }
});

// ================= ERROR LOG =================
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});