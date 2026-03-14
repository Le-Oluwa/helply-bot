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

  const terms = `
📜 *Helply Terms & Conditions*

1️⃣ Users must provide accurate task details.
2️⃣ Service providers must perform tasks responsibly.
3️⃣ Total cost = Item price + Runner fee + Platform fee.
4️⃣ Helply only connects users and runners.
5️⃣ Illegal activities are prohibited.
6️⃣ Repeated cancellations may lead to suspension.
7️⃣ Item availability depends on vendor stock.
8️⃣ Respectful communication is required.

By clicking *Accept*, you agree to these terms.
`;

  bot.sendMessage(msg.chat.id, terms, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Accept Terms", callback_data: "accept_terms" }]
      ]
    }
  });
});


// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {

  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;


  // ================= CAFETERIA RUN =================
  if (msg.text === "🍛 Cafeteria Runs") {

    const { data: restaurants } = await supabase
      .from("restaurants")
      .select("*");

    if (!restaurants || restaurants.length === 0) {
      return bot.sendMessage(msg.chat.id, "No restaurants available.");
    }

    const buttons = restaurants.map(r => [
      { text: r.name, callback_data: `restaurant_${r.id}` }
    ]);

    return bot.sendMessage(
      msg.chat.id,
      "🍛 Choose a restaurant:",
      { reply_markup: { inline_keyboard: buttons } }
    );
  }


  // ================= SHOPPING MALL =================
  if (msg.text === "🛍 Shopping Mall Runs") {

    return bot.sendMessage(
      msg.chat.id,
      `🛍 *Shopping Mall Run*

Send what you want to buy.

Example:
Buy toothpaste from the shopping mall`,
      { parse_mode: "Markdown" }
    );
  }


  // ================= CUSTOM ERRAND =================
  if (msg.text === "🏃 Custom Errands") {

    return bot.sendMessage(
      msg.chat.id,
      `🏃 *Custom Errand*

Describe the task clearly.

Example:
Help me print 20 pages.`,
      { parse_mode: "Markdown" }
    );
  }


  // ================= CREATE TASK =================

  const taskText = msg.text;
  const taskId = Math.random().toString(36).substring(2, 9);

  await supabase
    .from("orders")
    .insert([
      {
        id: taskId,
        user_id: msg.chat.id.toString(),
        task: taskText,
        status: "pending",
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

  bot.sendMessage(
    msg.chat.id,
    `✅ *Task Received*

🆔 Task ID: \`${taskId}\`

Waiting for a runner...`,
    { parse_mode: "Markdown" }
  );

  bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 *NEW HELPLY TASK*

🆔 Task ID: \`${taskId}\`
📌 ${taskText}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept Task", callback_data: `accept_${taskId}` }]
        ]
      }
    }
  );
});



// ================= CALLBACK HANDLER =================
bot.on("callback_query", async (query) => {

  const data = query.data;
  const runnerName = query.from.first_name;
  const runnerId = query.from.id;


  // ================= TERMS ACCEPT =================
  if (data === "accept_terms") {

    bot.sendMessage(
      query.from.id,
      `🎉 *Welcome to Helply*

What do you need today?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [
            ["🍛 Cafeteria Runs"],
            ["🛍 Shopping Mall Runs"],
            ["🏃 Custom Errands"]
          ],
          resize_keyboard: true
        }
      }
    );

    return bot.answerCallbackQuery(query.id);
  }


  // ================= RESTAURANT SELECT =================
  if (data.startsWith("restaurant_")) {

    const restaurantId = data.split("_")[1];

    const { data: menu } = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", restaurantId);

    if (!menu || menu.length === 0) {
      return bot.sendMessage(query.from.id, "No menu items available.");
    }

    const buttons = menu.map(item => [
      {
        text: `${item.item_name} — ₦${item.price}`,
        callback_data: `item_${item.id}`
      }
    ]);

    bot.sendMessage(
      query.from.id,
      "🍛 Select what you want:",
      { reply_markup: { inline_keyboard: buttons } }
    );

    return bot.answerCallbackQuery(query.id);
  }


  // ================= MENU ITEM SELECT =================
  if (data.startsWith("item_")) {

    const itemId = data.split("_")[1];

    const { data: item } = await supabase
      .from("menu_items")
      .select("*")
      .eq("id", itemId)
      .single();

    if (!item) {
      return bot.sendMessage(query.from.id, "Item not found.");
    }

    const runnerFee = 300;
    const helplyFee = 100;
    const total = item.price + runnerFee + helplyFee;

    bot.sendMessage(
      query.from.id,
      `🧾 *Order Summary*

Item: ${item.item_name}

Item Price: ₦${item.price}
Runner Fee: ₦${runnerFee}
Helply Fee: ₦${helplyFee}

💰 *Total: ₦${total}*`,
      { parse_mode: "Markdown" }
    );

    return bot.answerCallbackQuery(query.id);
  }



  // ================= ACCEPT TASK =================
  if (data.startsWith("accept_")) {

    const taskId = data.split("_")[1];

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", taskId)
      .single();

    if (!order || order.status === "assigned") {
      return bot.answerCallbackQuery(query.id, {
        text: "❌ Task already taken",
        show_alert: true
      });
    }

    await supabase
      .from("orders")
      .update({
        status: "assigned",
        runner_name: runnerName,
        runner_id: runnerId.toString(),
        updated_at: new Date()
      })
      .eq("id", taskId);

    bot.editMessageText(
      `${query.message.text}

✅ *Accepted by ${runnerName}*`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );

    bot.sendMessage(
      order.user_id,
      `🎉 *Your task has been accepted!*

Runner: ${runnerName}`,
      { parse_mode: "Markdown" }
    );

    // SEND CANCEL BUTTON
    bot.sendMessage(
      runnerId,
      `🛠 You accepted Task ID: ${taskId}

If you cannot complete it:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel Task",
                callback_data: `cancel_${taskId}`
              }
            ]
          ]
        }
      }
    );

    return bot.answerCallbackQuery(query.id);
  }



  // ================= CANCEL BUTTON =================
  if (data.startsWith("cancel_")) {

    const taskId = data.split("_")[1];

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", taskId)
      .single();

    if (!order || order.runner_id !== runnerId.toString()) {
      return bot.answerCallbackQuery(query.id, {
        text: "❌ You cannot cancel this task",
        show_alert: true
      });
    }

    bot.sendMessage(
      runnerId,
      `Why are you cancelling Task ${taskId}?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Item unavailable", callback_data: `reason_unavailable_${taskId}` }],
            [{ text: "Personal emergency", callback_data: `reason_emergency_${taskId}` }],
            [{ text: "Too far", callback_data: `reason_distance_${taskId}` }]
          ]
        }
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
        updated_at: new Date()
      })
      .eq("id", taskId);

    bot.sendMessage(
      order.user_id,
      `⚠️ Your task was cancelled.

Reason: ${reason}

Reposting task now.`,
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
            [{ text: "✅ Accept Task", callback_data: `accept_${taskId}` }]
          ]
        }
      }
    );

    bot.sendMessage(runnerId, "❌ Task cancelled successfully.");

    return bot.answerCallbackQuery(query.id);
  }

});


// ================= ERROR LOG =================
bot.on("polling_error", (err) => {
  console.log("Polling Error:", err.message);
});