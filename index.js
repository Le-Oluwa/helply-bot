require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const express = require("express");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
app.use(express.json());

const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;
const ADMIN_ID = 123456789;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

const negotiationState = {};
const broadcastState = {};

console.log("🚀 Helply Running");


// ================= FEE =================
function calculateTotal(price) {
  const platformFee = Math.ceil(price * 0.1);
  const flwFee = Math.ceil(price * 0.015);
  const total = price + platformFee + flwFee;
  return { platformFee, flwFee, total };
}


// ================= PAYMENT =================
async function createPaymentLink(amount, tx_ref) {
  try {
    const res = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount,
        currency: "NGN",
        redirect_url: "https://example.com",
        customer: { email: "user@email.com", name: "Helply User" },
        customizations: {
          title: "Helply Payment",
          description: "Task payment"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`
        }
      }
    );

    return res.data.data.link;
  } catch (err) {
    console.log("FLW ERROR:", err.response?.data || err.message);
    return null;
  }
}


// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId.toString())
    .maybeSingle();

  if (user?.accepted_terms) {
    return bot.sendMessage(userId, "👋 Welcome back to Helply!");
  }

  await bot.sendMessage(
    userId,
`👋 Welcome to Helply!

📜 Terms & Conditions

• Be respectful  
• No fraud or illegal use  
• Payments must go through the platform  
• Do not bypass Helply  
• Abuse leads to ban  

Do you accept?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: "accept_terms" }],
          [{ text: "❌ Decline", callback_data: "decline_terms" }]
        ]
      }
    }
  );
});


// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text.trim();

  // ================= FETCH USER =================
  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId.toString())
    .maybeSingle();

  // ================= HANDLE FIRST TIME USER =================
  if (!user) {
    await supabase.from("users").insert([{
      id: userId.toString(),
      accepted_terms: false,
      banned: false
    }]);

    return bot.sendMessage(
      userId,
      "⚠️ Please type /start and accept the terms first."
    );
  }

  // ================= BLOCK IF NOT ACCEPTED =================
  if (user.accepted_terms === false) {
    return bot.sendMessage(
      userId,
      "⚠️ Please use /start and accept the terms first."
    );
  }

  if (text.startsWith("/")) return;

  // ================= BROADCAST =================
  if (broadcastState[userId]) {
    const { data: users } = await supabase.from("users").select("id");

    let count = 0;

    for (const u of users) {
      try {
        await bot.sendMessage(u.id, text);
        count++;
        await new Promise(r => setTimeout(r, 50));
      } catch {}
    }

    delete broadcastState[userId];
    return bot.sendMessage(userId, `✅ Sent to ${count} users`);
  }

  // ================= NEGOTIATION =================
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
      await bot.sendMessage(offer.runner_id, `💬 ₦${price}`);
    } else {
      await bot.sendMessage(offer.user_id, `💬 ₦${price}`);
    }

    delete negotiationState[userId];
    return;
  }

  // ================= CREATE ORDER =================
  const taskId = Date.now();

  await supabase.from("orders").insert([{
    id: taskId,
    user_id: userId.toString(),
    delivery_location: text,
    status: "open"
  }]);

  bot.sendMessage(userId, `✅ Request sent\n🆔 ${taskId}`);

  bot.sendMessage(
    RUNNER_GROUP_ID,
    `🚨 NEW REQUEST\n🆔 ${taskId}\n📌 ${text}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Offer", callback_data: `offer_${taskId}_500` }]
        ]
      }
    }
  );
});


// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const userId = q.from.id;

  // ===== ACCEPT TERMS =====
  if (data === "accept_terms") {
    await supabase.from("users").upsert([{
      id: userId.toString(),
      accepted_terms: true,
      banned: false
    }]);

    return bot.sendMessage(
      userId,
      "✅ You can now use Helply!\n\nSend your request."
    );
  }

  // ===== DECLINE =====
  if (data === "decline_terms") {
    return bot.sendMessage(userId, "❌ You must accept to continue.");
  }

  // ===== ADMIN BROADCAST =====
  if (data === "admin_broadcast") {
    broadcastState[userId] = true;
    return bot.sendMessage(userId, "📢 Type message:");
  }

  // ===== OFFER =====
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

  // ===== SUBMIT OFFER =====
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
      runner_name: q.from.first_name,
      current_price: Number(price),
      last_actor: "runner"
    }]);

    return bot.sendMessage(order.user_id, "💰 Offer received");
  }

  // ===== ACCEPT + PAYMENT =====
  if (data.startsWith("accept_")) {
    const id = data.split("_")[1];

    const { data: o } = await supabase
      .from("offers")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    const { platformFee, total } = calculateTotal(o.current_price);

    const tx_ref = `tx_${o.order_id}_${Date.now()}`;

    await supabase.from("orders").update({
      agreed_price: o.current_price,
      platform_fee: platformFee,
      total_price: total,
      runner_id: o.runner_id,
      status: "pending_payment"
    }).eq("id", Number(o.order_id));

    const link = await createPaymentLink(total, tx_ref);

    return bot.sendMessage(userId, `💳 Pay ₦${total}\n${link}`);
  }
});


// ================= WEBHOOK =================
app.post("/flutterwave/webhook", async (req, res) => {
  try {
    const data = req.body.data;

    if (data?.status === "successful") {
      const orderId = data.tx_ref.split("_")[1];

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", Number(orderId))
        .maybeSingle();

      await supabase.from("orders").update({
        status: "paid"
      }).eq("id", Number(orderId));

      await bot.sendMessage(order.user_id, "✅ Payment confirmed!");
      await bot.sendMessage(order.runner_id, "💰 Proceed!");
    }

    res.sendStatus(200);
  } catch (err) {
    console.log("Webhook error:", err.message);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});