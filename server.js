require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================= INIT =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const bot = new TelegramBot(process.env.BOT_TOKEN);

console.log("🚀 SERVER STARTING...");
console.log("FLW KEY:", process.env.FLW_SECRET_KEY ? "Loaded ✅" : "Missing ❌");


// ================= HEALTH =================
app.get("/", (req, res) => {
  res.send("💰 Helply Backend Running");
});


// ================= CREATE PAYMENT =================
app.get("/create-payment", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.send("Missing orderId");
    }

    // 🔥 Fetch order
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, agreed_price, total_price")
      .eq("id", orderId)
      .single();

    if (error || !order) {
      return res.send("Order not found");
    }

    // 🔥 SAFETY FIX (VERY IMPORTANT)
    let amount = Number(order.total_price);

    // fallback if total_price missing
    if (!amount || amount <= 0) {
      console.log("⚠️ total_price missing, recalculating...");
      const agreed = Number(order.agreed_price);

      if (!agreed || agreed <= 0) {
        return res.send("Invalid order amount. Recreate order.");
      }

      amount = Math.ceil(agreed * 1.05); // 🔥 5% fee

      // optional: update DB so it doesn't break again
      await supabase
        .from("orders")
        .update({ total_price: amount })
        .eq("id", orderId);
    }

    console.log("💰 CHARGING:", amount);

    const tx_ref = `order_${orderId}_${Date.now()}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount,
        currency: "NGN",
        redirect_url:
          "https://courageous-connection-production-3317.up.railway.app/payment-success",
        payment_options: "card,banktransfer,ussd",

        customer: {
          email: "user@helply.com",
          name: "Helply User"
        },

        customizations: {
          title: "Helply Payment",
          description: `Payment for order ${orderId}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.redirect(response.data.data.link);

  } catch (err) {
    console.error("❌ PAYMENT ERROR:", err.response?.data || err.message);
    return res.send("Error creating payment");
  }
});


// ================= PAYMENT SUCCESS =================
app.get("/payment-success", async (req, res) => {
  try {
    const { tx_ref, status } = req.query;

    if (!tx_ref) {
      return res.send("<h1>Missing tx_ref</h1>");
    }

    const orderId = tx_ref.split("_")[1];

    // 🔐 VERIFY
    const verifyRes = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const paymentData = verifyRes.data;

    console.log("VERIFY RESPONSE:", paymentData);

    if (
      paymentData.status !== "success" ||
      paymentData.data.status !== "successful"
    ) {
      return res.send(`<h1>❌ Payment Not Completed</h1>`);
    }

    // 🔍 GET ORDER
    const { data: order } = await supabase
      .from("orders")
      .select("id, total_price, payment_status, runner_id, user_id")
      .eq("id", orderId)
      .single();

    if (!order) {
      return res.send("<h1>Order not found</h1>");
    }

    if (order.payment_status === "paid") {
      return res.send("<h1>Already paid</h1>");
    }

    if (!order.runner_id) {
      return res.send("<h1>No runner assigned</h1>");
    }

    // 🔥 STRICT CHECK
    if (
      Number(paymentData.data.amount) !== Number(order.total_price)
    ) {
      console.log("❌ AMOUNT MISMATCH:", paymentData.data.amount, order.total_price);
      return res.send("<h1>Amount mismatch</h1>");
    }

    // ✅ UPDATE ORDER
    await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        status: "in_progress"
      })
      .eq("id", orderId);

    console.log("✅ ORDER UPDATED:", orderId);

    // 🔓 NOTIFY RUNNER
    await bot.sendMessage(
      order.runner_id,
      `💰 Payment Confirmed!

🆔 Order: ${orderId}
🚀 Start the task.`
    );

    // 🔓 NOTIFY USER
    await bot.sendMessage(
      order.user_id,
      `✅ Payment Successful!

🆔 Order: ${orderId}

🤝 You can now chat with your runner.`
    );

    return res.send(`
      <h1>✅ Payment Successful</h1>
      <p>Order ID: ${orderId}</p>
      <p>Amount: ₦${paymentData.data.amount}</p>
    `);

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);
    return res.send("<h1>Error verifying payment</h1>");
  }
});


// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
