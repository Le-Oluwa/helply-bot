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

const negotiationState = {};
const broadcastState = {};
const ADMIN_ID = 123456789;

console.log("🚀 Helply Running");


// ================= ADMIN =================
bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  await bot.sendMessage(msg.from.id, "📊 Admin Dashboard", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Send Broadcast", callback_data: "admin_broadcast" }],
        [{ text: "📜 View Broadcasts", callback_data: "admin_view_broadcasts" }]
      ]
    }
  });
});


// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text.trim();

  if (text.startsWith("/")) return;

  // ===== BROADCAST =====
  if (broadcastState[userId]) {
    await supabase.from("broadcasts").insert([{
      message: text,
      created_at: new Date()
    }]);

    const { data: users } = await supabase.from("users").select("id");

    for (const u of users) {
      try {
        await bot.sendMessage(u.id, text);
        await new Promise(r => setTimeout(r, 50));
      } catch {}
    }

    delete broadcastState[userId];
    return bot.sendMessage(userId, "✅ Broadcast sent!");
  }

  // ===== NEGOTIATION INPUT =====
  if (negotiationState[userId]) {
    const price = Number(text);
    const { offerId, role } = negotiationState[userId];

    const { data: offer } = await supabase
      .from("offers")
      .select("*")
      .eq("id", offerId)
      .maybeSingle();

    await supabase.from("offers").update({
      current_price: price,
      last_actor: role
    }).eq("id", offerId);

    if (role === "user") {
      await bot.sendMessage(offer.runner_id,
        `💬 Customer countered: ₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Accept", callback_data: `accept_${offerId}` }],
              [{ text: "Counter", callback_data: `counter_runner_${offerId}` }]
            ]
          }
        });
    } else {
      await bot.sendMessage(offer.user_id,
        `💬 Runner countered: ₦${price}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Accept", callback_data: `accept_${offerId}` }],
              [{ text: "Counter", callback_data: `counter_user_${offerId}` }]
            ]
          }
        });
    }

    delete negotiationState[userId];
    return;
  }

  // ===== CREATE ORDER =====
  const taskId = Date.now();

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId.toString(),
    delivery_location: text,
    status: "open"
  }]);

  bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

  bot.sendMessage(RUNNER_GROUP_ID,
    `🚨 NEW TASK\n🆔 ${taskId}\n${text}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Offer", callback_data: `offer_${taskId}_500` }]
        ]
      }
    });
});


// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;

  // ===== ADMIN =====
  if (data === "admin_broadcast") {
    broadcastState[userId] = true;
    return bot.sendMessage(userId, "Send broadcast message:");
  }

  if (data === "admin_view_broadcasts") {
    const { data: b } = await supabase
      .from("broadcasts")
      .select("*")
      .limit(5);

    let msg = "📜 Broadcasts:\n\n";
    b.forEach(x => msg += x.message + "\n\n");

    return bot.sendMessage(userId, msg);
  }

  // ===== OFFER FLOW =====
  if (data.startsWith("offer_")) {
    const [_, taskId, price] = data.split("_");

    return bot.sendMessage(userId, `₦${price}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "+100", callback_data: `price_${taskId}_${+price+100}` }],
          [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
        ]
      }
    });
  }

  if (data.startsWith("price_")) {
    const [_, taskId, price] = data.split("_");

    return bot.sendMessage(userId, `₦${price}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "+100", callback_data: `price_${taskId}_${+price+100}` }],
          [{ text: "Submit", callback_data: `submit_${taskId}_${price}` }]
        ]
      }
    });
  }

  if (data.startsWith("submit_")) {
    const [_, taskId, price] = data.split("_");

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", Number(taskId))
      .maybeSingle();

    await supabase.from("offers").insert([{
      id: uuidv4(),
      order_id: String(taskId),
      user_id: order.user_id,
      runner_id: userId.toString(),
      runner_name: query.from.first_name,
      current_price: Number(price),
      last_actor: "runner"
    }]);

    const { data: offers } = await supabase
      .from("offers")
      .select("*")
      .eq("order_id", String(taskId));

    const buttons = offers.map(o => [{
      text: `${o.runner_name} ₦${o.current_price}`,
      callback_data: `view_${o.id}`
    }]);

    return bot.sendMessage(order.user_id, "Offers:", {
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
      .maybeSingle();

    return bot.sendMessage(userId,
      `${o.runner_name} ₦${o.current_price}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Accept", callback_data: `accept_${id}` }],
            [{ text: "Counter", callback_data: `counter_user_${id}` }]
          ]
        }
      });
  }

  // ===== COUNTER =====
  if (data.startsWith("counter_user_")) {
    negotiationState[userId] = {
      offerId: data.split("_")[2],
      role: "user"
    };
    return bot.sendMessage(userId, "Enter price:");
  }

  if (data.startsWith("counter_runner_")) {
    negotiationState[userId] = {
      offerId: data.split("_")[2],
      role: "runner"
    };
    return bot.sendMessage(userId, "Enter price:");
  }

  // ===== ACCEPT =====
  if (data.startsWith("accept_")) {
    const id = data.split("_")[1];

    const { data: o } = await supabase
      .from("offers")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    await bot.sendMessage(o.user_id, "✅ Accepted!");
    await bot.sendMessage(o.runner_id, "🎉 You got it!");
  }
});