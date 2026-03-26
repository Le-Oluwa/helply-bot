require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

console.log("🚀 Stable Bot Running");

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const text = msg.text.trim();
  const userId = msg.from.id;

  console.log("📩 MESSAGE:", text);

  // ================= OFFER COMMAND =================
  if (text.startsWith("/offer")) {
    const parts = text.split(" ");

    if (parts.length < 3) {
      return bot.sendMessage(msg.chat.id, "❌ Use: /offer taskId price");
    }

    const taskId = parts[1];
    const price = Number(parts[2]);

    if (!price || price < 100) {
      return bot.sendMessage(msg.chat.id, "❌ Enter valid price (e.g. 500)");
    }

    // SAVE OFFER
    const { error } = await supabase.from("offers").insert([{
      id: uuidv4(),
      order_id: taskId,
      runner_id: userId.toString(),
      runner_name: msg.from.first_name,
      price
    }]);

    if (error) {
      console.log("❌ OFFER ERROR:", error);
      return bot.sendMessage(msg.chat.id, "❌ Failed to save offer.");
    }

    console.log("✅ OFFER SAVED");

    // GET ORDER
    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();

    if (!order) {
      return bot.sendMessage(msg.chat.id, "❌ Task not found.");
    }

    const customerId = parseInt(order.user_id, 10);

    // NOTIFY CUSTOMER
    bot.sendMessage(
      customerId,
      `💰 New Offer\n👤 ${msg.from.first_name}\n💵 ₦${price}`
    );

    return bot.sendMessage(msg.chat.id, "✅ Offer submitted!");
  }

  // ignore other commands
  if (text.startsWith("/")) return;

  // ================= NEW REQUEST =================
  if (msg.chat.type === "private") {

    const taskId = Math.random().toString(36).substring(2, 9);

    const { error } = await supabase.from("orders").insert([{
      id: taskId,
      user_id: userId.toString(),
      task: text,
      status: "open",
      created_at: new Date()
    }]);

    if (error) {
      console.log("❌ ORDER ERROR:", error);
      return bot.sendMessage(userId, "❌ Failed to create request.");
    }

    console.log("✅ ORDER CREATED:", taskId);

    bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 NEW TASK\n\n🆔 ${taskId}\n📌 ${text}\n\nSend offer:\n/offer ${taskId} 500`
    );
  }
});

process.on("unhandledRejection", (err) => console.log("UNHANDLED:", err));
process.on("uncaughtException", (err) => console.log("UNCAUGHT:", err));