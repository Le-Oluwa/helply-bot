require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RUNNER_GROUP_ID = String(process.env.RUNNER_GROUP_ID);

console.log("🚀 Helply Running");

// ================= HELPER =================
async function isUserBusyAsCustomer(userId) {
  const { data } = await supabase
    .from("orders")
    .select("id")
    .eq("user_id", userId)
    .in("status", ["open", "matched", "in_progress"]);

  return data && data.length > 0;
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();
  const username = msg.from.username || "";

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user) {
    await supabase.from("users").insert([{
      id: userId,
      username,
      accepted_terms: false,
      banned: false
    }]);

    return bot.sendMessage(userId,
`👋 Welcome to Helply!

Please accept Terms & Conditions.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Accept", callback_data: "accept_terms" }],
            [{ text: "❌ Decline", callback_data: "decline_terms" }]
          ]
        }
      }
    );
  }

  // update username
  await supabase
    .from("users")
    .update({ username })
    .eq("id", userId);

  return bot.sendMessage(userId,
`👋 Welcome back!

Send your request 🚀`);
});

// ================= TERMS =================
bot.onText(/\/terms/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📜 Terms:

• Pay before task starts  
• Helply takes 10%  
• No fraud  
• Respect runners`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: "accept_terms" }]
        ]
      }
    }
  );
});

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  if (text.startsWith("/")) return;

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (!user || !user.accepted_terms) {
    return bot.sendMessage(userId, "⚠️ Accept terms first (/start)");
  }

  // active chat
  const { data: activeOrder } = await supabase
    .from("orders")
    .select("*")
    .or(`user_id.eq.${userId},runner_id.eq.${userId}`)
    .eq("payment_status", "paid")
    .eq("status", "in_progress")
    .maybeSingle();

  if (activeOrder) {
    const receiver =
      userId === activeOrder.user_id
        ? activeOrder.runner_id
        : activeOrder.user_id;

    return bot.sendMessage(receiver, `💬 ${text}`);
  }

  // create order
  const taskId = Date.now();

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId,
    user_username: msg.from.username || "",
    delivery_location: text,
    status: "open",
    payment_status: "pending"
  }]);

  await bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

  // send to group
  await bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 NEW REQUEST

🆔 ${taskId}
📌 ${text}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Make Offer", callback_data: `offer_${taskId}_500` }]
        ]
      }
    }
  );
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id.toString();

  try {

    // ===== TERMS =====
    if (data === "accept_terms") {
      await supabase
        .from("users")
        .update({ accepted_terms: true })
        .eq("id", userId);

      return bot.sendMessage(userId, "🎉 You're in!");
    }

    // ===== OFFER =====
    if (data.startsWith("offer_")) {
      const busy = await isUserBusyAsCustomer(userId);
      if (busy) {
        return bot.answerCallbackQuery(q.id, {
          text: "❌ Finish your request first",
          show_alert: true
        });
      }

      const [_, taskId, price] = data.split("_");

      return bot.sendMessage(userId,
`💰 Set your offer

₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "+100", callback_data: `adj_${taskId}_${price}_100` }],
              [{ text: "✅ Submit", callback_data: `submit_${taskId}_${price}` }]
            ]
          }
        }
      );
    }

    // ===== ADJUST =====
    if (data.startsWith("adj_")) {
      const [_, taskId, current, change] = data.split("_");

      const newPrice = Number(current) + Number(change);

      return bot.editMessageText(
`₦${newPrice}`,
        {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: "+100", callback_data: `adj_${taskId}_${newPrice}_100` }],
              [{ text: "✅ Submit", callback_data: `submit_${taskId}_${newPrice}` }]
            ]
          }
        }
      );
    }

    // ===== SUBMIT =====
    if (data.startsWith("submit_")) {
      const [_, taskId, price] = data.split("_");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(taskId))
        .single();

      await supabase.from("offers").insert([{
        id: uuidv4(),
        order_id: String(taskId),
        user_id: order.user_id,
        runner_id: userId,
        runner_name: q.from.first_name,
        runner_username: q.from.username || "",
        current_price: Number(price)
      }]);

      const { data: offers } = await supabase
        .from("offers")
        .select("*")
        .eq("order_id", String(taskId));

      const buttons = offers.map(o => [
        { text: `${o.runner_name} — ₦${o.current_price}`, callback_data: `view_${o.id}` }
      ]);

      return bot.sendMessage(order.user_id, "💰 Offers:", {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    // ===== VIEW =====
    if (data.startsWith("view_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .single();

      return bot.sendMessage(userId,
`${o.runner_name} — ₦${o.current_price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `accept_${id}` }]
            ]
          }
        }
      );
    }

    // ===== ACCEPT =====
    if (data.startsWith("accept_")) {
      const id = data.split("_")[1];

      const { data: o } = await supabase
        .from("offers")
        .select("*")
        .eq("id", id)
        .single();

      const agreed = Number(o.current_price);
      const total = Math.ceil(agreed * 1.05);

      await supabase.from("orders").update({
        runner_id: o.runner_id,
        runner_username: o.runner_username,
        agreed_price: agreed,
        total_price: total,
        status: "matched"
      }).eq("id", Number(o.order_id));

      const link = `https://your-payment-url/create-payment?orderId=${o.order_id}`;

      await bot.sendMessage(o.user_id, `💳 Pay:\n${link}`);

      await bot.sendMessage(o.runner_id,
`🎉 Task assigned`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel Task", callback_data: `cancel_${o.order_id}` }]
            ]
          }
        }
      );
    }

    // ===== CANCEL =====
    if (data.startsWith("cancel_")) {
      const orderId = data.split("_")[1];

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(orderId))
        .single();

      if (order.runner_id !== userId) return;

      await supabase.from("orders").update({
        runner_id: null,
        status: "open"
      }).eq("id", Number(orderId));

      await bot.sendMessage(order.user_id,
`⚠️ Runner cancelled. Reassigning...`);

      await bot.sendMessage(
        RUNNER_GROUP_ID,
        `🚨 TASK REOPENED

🆔 ${orderId}
📌 ${order.delivery_location}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 Make Offer", callback_data: `offer_${orderId}_500` }]
            ]
          }
        }
      );
    }

  } catch (err) {
    console.log("❌ ERROR:", err.message);
  }
});
