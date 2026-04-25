require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// 🔥 DEBUG LOGS
console.log("🚀 SERVER STARTING...");
console.log("FLW KEY START:", process.env.FLW_SECRET_KEY?.slice(0, 15));
console.log("PORT:", process.env.PORT);
console.log(
  "FLW KEY:",
  process.env.FLW_SECRET_KEY ? "Loaded ✅" : "Missing ❌"
);

// ================= HEALTH CHECK =================
app.get("/", (req, res) => {
  res.status(200).send("💰 Payment server running");
});

// ================= CREATE PAYMENT =================
app.get("/payment-success", async (req, res) => {
  try {
    const { tx_ref, status } = req.query;

    if (!tx_ref) {
      return res.send("<h1>Missing transaction reference</h1>");
    }

    // 🔍 Extract orderId
    const parts = tx_ref.split("_");
    const orderId = parts[1];

    // 🔐 Verify payment with Flutterwave
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

    // ❌ Payment not successful
    if (
      paymentData.status !== "success" ||
      paymentData.data.status !== "successful"
    ) {
      return res.send(`
        <h1>❌ Payment Not Completed</h1>
        <p>Status: ${status || "unknown"}</p>
      `);
    }

    // 🔍 Fetch order from DB
    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("id, agreed_price, payment_status")
      .eq("id", orderId)
      .single();

    if (fetchError || !order) {
      console.error("❌ ORDER FETCH ERROR:", fetchError);
      return res.send("<h1>Order not found</h1>");
    }

    // 🛑 Prevent double payment processing
    if (order.payment_status === "paid") {
      return res.send(`
        <h1>✅ Already Paid</h1>
        <p>Order ID: ${orderId}</p>
      `);
    }

    // 🔥 SECURITY CHECK (VERY IMPORTANT)
    if (Number(paymentData.data.amount) !== Number(order.agreed_price)) {
      console.error("❌ AMOUNT MISMATCH");

      return res.send(`
        <h1>❌ Payment Error</h1>
        <p>Amount mismatch detected</p>
      `);
    }

    // ✅ UPDATE ORDER
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        status: "paid"
      })
      .eq("id", orderId);

    if (updateError) {
      console.error("❌ DB UPDATE ERROR:", updateError);
      return res.send("<h1>Error updating order</h1>");
    }

    console.log("✅ ORDER UPDATED:", orderId);

    // 🚀 READY FOR RUNNERS (next step)
    console.log("🚀 SEND TO RUNNERS:", orderId);

    return res.send(`
      <h1>✅ Payment Successful</h1>
      <p>Order ID: ${orderId}</p>
      <p>Amount: ₦${paymentData.data.amount}</p>
      <p>🚀 Your task is now live!</p>
    `);

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);

    return res.send(`
      <h1>⚠️ Error verifying payment</h1>
      <p>Please contact support</p>
    `);
  }
});

// ================= PAYMENT SUCCESS =================
app.get("/payment-success", async (req, res) => {
  try {
    const { tx_ref, status } = req.query;

    if (!tx_ref) {
      return res.send("<h1>Missing tx_ref</h1>");
    }

    // 🔍 Extract orderId
    const parts = tx_ref.split("_");
    const orderId = parts[1];

    // 🔐 Verify payment
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

    // ❌ If payment not successful
    if (
      paymentData.status !== "success" ||
      paymentData.data.status !== "successful"
    ) {
      return res.send(`
        <h1>❌ Payment Not Completed</h1>
        <p>Status: ${status || "unknown"}</p>
      `);
    }

    // 🔍 Fetch order from DB
    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("id, agreed_price, payment_status")
      .eq("id", orderId)
      .single();

    if (fetchError || !order) {
      console.error("❌ ORDER FETCH ERROR:", fetchError);
      return res.send("<h1>Order not found</h1>");
    }

    // 🛑 Prevent double processing
    if (order.payment_status === "paid") {
      return res.send(`
        <h1>✅ Already Paid</h1>
        <p>Order ID: ${orderId}</p>
      `);
    }

    // 🔥 SECURITY: amount must match agreed_price
    if (
      Number(paymentData.data.amount) !== Number(order.agreed_price)
    ) {
      console.error("❌ AMOUNT MISMATCH");

      return res.send(`
        <h1>❌ Payment Error</h1>
        <p>Amount mismatch detected</p>
      `);
    }

    // ✅ Update order
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        status: "paid"
      })
      .eq("id", orderId);

    if (updateError) {
      console.error("❌ DB UPDATE ERROR:", updateError);
      return res.send("<h1>Error updating order</h1>");
    }

    console.log("✅ ORDER UPDATED:", orderId);

    // 🚀 SEND TO RUNNERS (THIS IS THE BIG STEP)
    await bot.sendMessage(
      process.env.RUNNER_CHAT_ID,
      `🚀 NEW TASK AVAILABLE

🆔 Order: ${orderId}
💰 Price: ₦${paymentData.data.amount}

Reply with:
accept ${orderId}`
    );

    console.log("📢 SENT TO RUNNERS:", orderId);

    return res.send(`
      <h1>✅ Payment Successful</h1>
      <p>Order ID: ${orderId}</p>
      <p>Amount: ₦${paymentData.data.amount}</p>
      <p>🚀 Your task is now live!</p>
    `);

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);

    return res.send(`
      <h1>⚠️ Error verifying payment</h1>
    `);
  }
});
// ================= VERIFY PAYMENT (OPTIONAL API) =================
app.get("/verify-payment/:tx_ref", async (req, res) => {
  try {
    const { tx_ref } = req.params;

    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const data = response.data;

    if (data.status === "success" && data.data.status === "successful") {
      return res.json({
        success: true,
        amount: data.data.amount
      });
    } else {
      return res.json({
        success: false
      });
    }

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ================= WEBHOOK =================
app.post("/webhook", (req, res) => {
  console.log("🔔 WEBHOOK RECEIVED:", req.body);
  res.sendStatus(200);
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

console.log("FINAL PORT:", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
