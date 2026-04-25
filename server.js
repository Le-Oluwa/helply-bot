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
app.get("/create-payment", async (req, res) => {
  try {
    const { orderId, amount } = req.query;

    if (!orderId || !amount) {
      return res.status(400).send("Missing orderId or amount");
    }

    const tx_ref = `tx_${orderId}_${Date.now()}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount: Number(amount),
        currency: "NGN",

        // ✅ FIXED: redirect back to your server
        redirect_url:
          "https://courageous-connection-production-3317.up.railway.app/payment-success",

        payment_options: "card,banktransfer,ussd",

        customer: {
          email: "test@helply.com",
          phonenumber: "08000000000",
          name: "Test User"
        },

        customizations: {
          title: "Helply Payment",
          description: `Task payment for ${orderId}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    // ✅ Redirect user to Flutterwave
    return res.redirect(response.data.data.link);

  } catch (err) {
    console.error("❌ FULL ERROR:", err.response?.data || err.message);

    return res.status(500).json({
      error: "Payment failed",
      details: err.response?.data || err.message
    });
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
