require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// 🔥 FORCE LOGS (IMPORTANT)
console.log("🚀 SERVER STARTING...");
console.log("PORT:", process.env.PORT);
console.log(
  "FLW KEY:",
  process.env.FLW_SECRET_KEY ? "Loaded ✅" : "Missing ❌"
);

// ================= HEALTH CHECK =================
app.get("/", (req, res) => {
  res.send("💰 Payment server running");
});

// ================= CREATE PAYMENT =================
app.post("/create-payment", async (req, res) => {
  try {
    const { orderId, amount } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ error: "Missing orderId or amount" });
    }

    if (!process.env.FLW_SECRET_KEY) {
      console.error("❌ Missing FLW_SECRET_KEY");
      return res.status(500).json({ error: "Server not configured" });
    }

    const tx_ref = `tx_${orderId}_${Date.now()}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount,
        currency: "NGN",
        redirect_url: "https://google.com",
        customer: {
          email: "user@helply.com",
          name: "Helply User"
        },
        customizations: {
          title: "Helply Payment",
          description: "Task payment"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      link: response.data.data.link,
      tx_ref
    });

  } catch (err) {
    console.error("❌ PAYMENT ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Payment failed",
      details: err.response?.data || err.message
    });
  }
});

// ================= WEBHOOK =================
app.post("/webhook", (req, res) => {
  console.log("🔔 WEBHOOK RECEIVED:", req.body);
  res.sendStatus(200);
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
