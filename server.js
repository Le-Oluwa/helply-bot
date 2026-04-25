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

    // 🔍 Extract orderId from tx_ref
    // format: order_123_171234567
    const parts = tx_ref.split("_");
    const orderId = parts[1];

    // 🔐 Verify payment from Flutterwave
    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const data = response.data;

    console.log("VERIFY RESPONSE:", data);

    // ✅ DOUBLE CHECK PAYMENT
    if (
      data.status === "success" &&
      data.data.status === "successful" &&
      data.data.amount > 0
    ) {

      // 🔥 THIS IS WHERE YOUR BUSINESS LOGIC STARTS
      console.log("✅ PAYMENT CONFIRMED FOR ORDER:", orderId);

      // 👉 later: save to DB here
      // 👉 later: notify runners here

      return res.send(`
        <h1>✅ Payment Successful</h1>
        <p>Order ID: ${orderId}</p>
        <p>Amount: ₦${data.data.amount}</p>
        <p>Reference: ${data.data.tx_ref}</p>
        <p>🚀 Your task is now live!</p>
      `);

    } else {
      return res.send(`
        <h1>❌ Payment Not Completed</h1>
        <p>Status: ${status || "unknown"}</p>
      `);
    }

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
    const { tx_ref } = req.query;

    if (!tx_ref) {
      return res.send("Missing tx_ref");
    }

    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const data = response.data;

    console.log("VERIFY RESPONSE:", data);

    if (data.status === "success" && data.data.status === "successful") {
      return res.send(`
        <h1>✅ Payment Successful</h1>
        <p>Amount: ₦${data.data.amount}</p>
        <p>Reference: ${data.data.tx_ref}</p>
      `);
    } else {
      return res.send(`
        <h1>❌ Payment Not Completed</h1>
      `);
    }

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);
    res.send("<h1>Error verifying payment</h1>");
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
