require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const RUNNER_GROUP_ID = String(process.env.RUNNER_GROUP_ID);

console.log("🚀 DEBUG BOT STARTED");
console.log("GROUP ID:", RUNNER_GROUP_ID);


// ================= LOG ALL MESSAGES =================
bot.on("message", async (msg) => {
  console.log("📩 MESSAGE RECEIVED:");
  console.log("FROM:", msg.from.id);
  console.log("CHAT:", msg.chat.id);
  console.log("TEXT:", msg.text);

  // Reply to user so we know bot is alive
  await bot.sendMessage(msg.chat.id, "✅ I received your message");

  // ================= TEST GROUP SEND =================
  try {
    console.log("📤 Trying to send to group...");

    await bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 TEST MESSAGE

From: ${msg.from.first_name}
Message: ${msg.text}`
    );

    console.log("✅ SENT TO GROUP SUCCESSFULLY");

  } catch (err) {
    console.error("❌ GROUP SEND FAILED:");
    console.error(err.response?.body || err.message);
  }
});
