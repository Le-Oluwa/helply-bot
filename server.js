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
    const orderId = req.query.orderId;
    const amount = req.query.amount;

    if (!orderId || !amount) {
      return res.status(400).send("Missing orderId or amount");
    }

    const tx_ref = `tx_${orderId}_${Date.now()}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount: Number(amount), // 🔥 important
        currency: "NGN",

        // 🔥 VERY IMPORTANT (must be a real reachable URL)
        redirect_url: "https://www.google.com",

        payment_options: "card,banktransfer",

        customer: {
          email: "test@helply.com",
          phonenumber: "08000000000",
          name: "Test User"
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

    // 🔥 redirect user instead of returning JSON
    return res.redirect(response.data.data.link);

  } catch (err) {
    console.error("❌ FULL ERROR:", err.response?.data || err.message);

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

console.log("FINAL PORT:", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});


// ================= VERIFY PAYMENT =================
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

    console.log("VERIFY RESPONSE:", data);

    if (data.status === "success" && data.data.status === "successful") {
      return res.json({
        success: true,
        message: "Payment verified",
        amount: data.data.amount
      });
    } else {
      return res.json({
        success: false,
        message: "Payment not successful yet"
      });
    }

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});
// TEMP TEST ROUTE (FOR BROWSER)
app.get("/create-payment", async (req, res) => {
  try {
    const { orderId, amount } = req.query;

    if (!orderId || !amount) {
      return res.send("Missing orderId or amount in query");
    }

    const tx_ref = `tx_${orderId}_${Date.now()}`;

    const response = await axios.post(
  "https://api.flutterwave.com/v3/payments",
  {
    tx_ref,
    amount,
    currency: "NGN",
    redirect_url: "https://flutterwave.com",

    // 🔥 ENABLE MULTIPLE PAYMENT METHODS
    payment_options: "card,banktransfer,ussd",

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

    return res.send(`
      <h2>Payment Link</h2>
      <a href="${response.data.data.link}" target="_blank">Pay Now</a>
      <p>tx_ref: ${tx_ref}</p>
    `);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Error creating payment");
  }
});
