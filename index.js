require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
const RUNNER_GROUP_ID = Number(process.env.RUNNER_GROUP_ID);

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

// ================= RUNNER ACCEPT (BUTTON) =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const runnerName = query.from.first_name;

  if (!data.startsWith("accept_")) return;

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

  // Lock task
  task.status = "assigned";
  task.runner = runnerName;

  // Update runners group message
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

  // Notify user
  bot.sendMessage(
    task.userId,
    `🎉 *Your task has been accepted!*

👤 Runner: ${runnerName}

They’ll contact you shortly.`,
    { parse_mode: "Markdown" }
  );

  bot.answerCallbackQuery(query.id, {
    text: "✅ You accepted this task",
  });
});

// ================= ERROR LOG =================
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("🤖 Helply bot is running with buttons...");
