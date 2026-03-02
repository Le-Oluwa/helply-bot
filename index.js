console.log("BOT_TOKEN:", process.env.BOT_TOKEN);
console.log("RUNNER_GROUP_ID:", process.env.RUNNER_GROUP_ID);
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");


const BOT_TOKEN = process.env.BOT_TOKEN;
const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

if (!BOT_TOKEN || !RUNNER_GROUP_ID) {
  console.error("❌ Missing BOT_TOKEN or RUNNER_GROUP_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// In-memory task store (MVP)
const tasks = {};

// ================= START =================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.type !== "private") return;

  bot.sendMessage(
    msg.chat.id,
    `👋 *Welcome to Helply*

Send your request in ONE message.

Examples:
• Buy water from cafeteria by 12pm, room D401
• Get rice from Hephzibah by 11am, room F409

A trusted student runner will accept it.`,
    { parse_mode: "Markdown" }
  );
});

// ================= USER REQUEST =================
bot.on("message", (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const taskText = msg.text;

  const timeMatch = taskText.match(/by ([^,]+)/i);
  const time = timeMatch ? timeMatch[1] : "Not specified";

  const roomMatch = taskText.match(/room ([^,]+)/i);
  const location = roomMatch ? roomMatch[1] : "Not specified";

  const taskId = Math.random().toString(36).substring(2, 9);

  tasks[taskId] = {
    userId: msg.chat.id,
    task: taskText,
    status: "pending",
  };

  // Confirm user
  bot.sendMessage(
    msg.chat.id,
    `✅ *Task Received*

🆔 Task ID: \`${taskId}\`
⏰ Time: ${time}
📍 Location: ${location}

Waiting for a runner…`,
    { parse_mode: "Markdown" }
  );

  // Send to runners group with button
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


// ================= RUNNER ACCEPT & CANCEL =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const runnerName = query.from.first_name;
  const runnerId = query.from.id;

  // ================= ACCEPT =================
  if (data.startsWith("accept_")) {
    const taskId = data.split("_")[1];
    const task = tasks[taskId];

    if (!task) {
      return bot.answerCallbackQuery(query.id, {
        text: "❌ Task not found",
        show_alert: true,
      });
    }

    if (task.status !== "pending") {
      return bot.answerCallbackQuery(query.id, {
        text: "❌ Task already taken",
        show_alert: true,
      });
    }

    task.status = "assigned";
    task.runner = runnerName;
    task.runnerId = runnerId;

    bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );

    bot.editMessageText(
      `${query.message.text}\n\n✅ *Accepted by ${runnerName}*`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
      }
    );

    bot.sendMessage(
      task.userId,
      `🎉 *Your task has been accepted!*

👤 Runner: ${runnerName}

They’ll contact you shortly.`,
      { parse_mode: "Markdown" }
    );

    // Send cancel option to runner privately
    bot.sendMessage(
      runnerId,
      `🛠 You accepted Task ID: ${taskId}

If you cannot continue, you may cancel:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel Task", callback_data: `cancel_${taskId}` }],
          ],
        },
      }
    );

    return bot.answerCallbackQuery(query.id, {
      text: "✅ You accepted this task",
    });
  }

  // ================= CANCEL =================
  if (data.startsWith("cancel_")) {
    const taskId = data.split("_")[1];
    const task = tasks[taskId];

    if (!task || task.runnerId !== runnerId) {
      return bot.answerCallbackQuery(query.id, {
        text: "❌ You cannot cancel this task",
        show_alert: true,
      });
    }

    // Ask for cancellation reason
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
    const task = tasks[taskId];

    if (!task) return;

    // Reset task
    task.status = "pending";
    task.runner = null;
    task.runnerId = null;

    // Notify user
    bot.sendMessage(
      task.userId,
      `⚠️ Your task was cancelled by the runner.

Reason: ${reason}

We're reposting it now.`,
      { parse_mode: "Markdown" }
    );

    // Repost task to runner group
    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🔁 *TASK REPOSTED*

🆔 Task ID: \`${taskId}\`
📌 ${task.task}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept Task", callback_data: `accept_${taskId}` }],
          ],
        },
      }
    );

    bot.sendMessage(runnerId, "❌ Task cancelled successfully.");

    return bot.answerCallbackQuery(query.id);
  }
});

// ================= ERROR LOG =================
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("🤖 Helply bot is running with buttons...");
