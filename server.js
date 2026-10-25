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

// The printer's numeric Telegram ID. Must have opened the bot and tapped Start.
const DEFAULT_PRINTER_CHAT_ID = "8912345642";
const PRINTER_CHAT_ID_ENV     = (process.env.PRINTER_CHAT_ID || "").trim();
const PRINTER_CHAT_ID         = /^-?\d+$/.test(PRINTER_CHAT_ID_ENV) ? PRINTER_CHAT_ID_ENV : DEFAULT_PRINTER_CHAT_ID;

const SUPPORT_EMAIL = "helply.cu@gmail.com";

console.log("🚀 SERVER STARTING...");
console.log("FLW KEY:", process.env.FLW_SECRET_KEY ? "Loaded ✅" : "Missing ❌");
console.log("PRINTER_CHAT_ID:", PRINTER_CHAT_ID);

// ================= HELPERS =================

function formatNaira(n) {
  return `₦${Number(n || 0).toLocaleString("en-NG")}`;
}

// Turns Telegram's errors into something actionable.
function explainPrinterError(err) {
  const msg = String((err && err.message) || err || "");
  if (/blocked by the user/i.test(msg))         return "The printer has blocked the bot.";
  if (/user is deactivated/i.test(msg))          return "The printer's Telegram account is deactivated.";
  if (/can't initiate conversation/i.test(msg))  return "The printer hasn't started the bot yet — ask them to open it and tap Start.";
  if (/chat not found/i.test(msg))               return "Telegram can't find that chat ID — check PRINTER_CHAT_ID is correct.";
  if (/wrong file identifier|wrong remote file/i.test(msg)) return "Telegram no longer accepts that file — ask the student to resend the document.";
  return msg || "Unknown Telegram error.";
}

// Sends a paid print job to the printer. Never throws.
async function sendPrintJobToPrinter(order) {
  if (!order.print_file_id) return { ok: false, reason: "No file on this order." };

  const colorLabel = order.print_color === "color" ? "Color" : "Black & White";
  const caption =
    `🖨️ Paid print job #${order.id}\n\n` +
    `${order.print_pages} page(s)\n${colorLabel}\nPaper: ${order.print_paper}\n` +
    `Binding: ${order.print_binding ? "Yes" : "No"}` +
    `${order.print_note ? `\nNote: ${order.print_note}` : ""}`;

  try {
    if (order.print_file_type === "document") {
      await bot.sendDocument(PRINTER_CHAT_ID, order.print_file_id, { caption });
    } else {
      await bot.sendPhoto(PRINTER_CHAT_ID, order.print_file_id, { caption });
    }
    console.log(`✅ PRINT JOB #${order.id} SENT TO PRINTER`);
    return { ok: true };
  } catch (err) {
    const reason = explainPrinterError(err);
    console.log(`❌ PRINT JOB #${order.id} NOT DELIVERED TO PRINTER: ${reason}`);
    return { ok: false, reason };
  }
}

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.send("💰 Helply Backend Running");
});

// ================= CREATE PAYMENT =================
app.get("/create-payment", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) return res.send("Missing orderId");

    // Fetch the order and the user's real details for Flutterwave
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, agreed_price, total_price, user_id")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) return res.send("Order not found");

    // Pull the user's real name, email and phone (collected at sign-up)
    const { data: user } = await supabase
      .from("users")
      .select("full_name, email, phone")
      .eq("id", order.user_id)
      .maybeSingle();

    let amount = Number(order.total_price);
    if (!amount || amount <= 0) {
      console.log("⚠️ total_price missing, recalculating...");
      const agreed = Number(order.agreed_price);
      if (!agreed || agreed <= 0) return res.send("Invalid order amount. Recreate order.");
      amount = Math.ceil(agreed * 1.3);
      await supabase.from("orders").update({ total_price: amount }).eq("id", orderId);
    }

    console.log("💰 CHARGING:", amount, "| USER:", user?.email || "unknown");

    const tx_ref = `order_${orderId}_${Date.now()}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount,
        currency: "NGN",
        redirect_url: "https://courageous-connection-production-3317.up.railway.app/payment-success",
        payment_options: "card,banktransfer,ussd",

        // Use the real user details — this is what was blocking payments
        customer: {
          email:       user?.email || `user_${order.user_id}@helply.app`,
          name:        user?.full_name || "Helply User",
          phonenumber: user?.phone || ""
        },

        customizations: {
          title:       "Helply Payment",
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
    const { tx_ref } = req.query;
    if (!tx_ref) return res.send("<h1>Missing tx_ref</h1>");

    const orderId = tx_ref.split("_")[1];

    // Verify the payment with Flutterwave
    const verifyRes = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );

    const paymentData = verifyRes.data;
    console.log("VERIFY RESPONSE:", paymentData);

    if (paymentData.status !== "success" || paymentData.data.status !== "successful") {
      return res.send(`<h1>❌ Payment Not Completed</h1>`);
    }

    // Fetch the full order (including print fields)
    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (!order)                          return res.send("<h1>Order not found</h1>");
    if (order.payment_status === "paid") return res.send("<h1>Already paid</h1>");
    if (!order.runner_id)                return res.send("<h1>No runner assigned</h1>");

    if (Number(paymentData.data.amount) !== Number(order.total_price)) {
      console.log("❌ AMOUNT MISMATCH:", paymentData.data.amount, order.total_price);
      return res.send("<h1>Amount mismatch</h1>");
    }

    // Mark as paid
    await supabase
      .from("orders")
      .update({ payment_status: "paid", status: "in_progress" })
      .eq("id", orderId);

    console.log("✅ ORDER UPDATED:", orderId);

    // Notify the runner (include food details if it's a food order)
    const foodLine = order.food_cost
      ? `\n\n🍽 Food to buy (${formatNaira(order.food_cost)}):\n${order.request_text}`
      : "";

    await bot.sendMessage(
      order.runner_id,
      `💰 Payment received!\n\n📦 Task is now active.${foodLine}\n\n💬 You can now chat with the user — just type any message here and it'll be sent to them.`,
      { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
    ).catch(err => console.log("RUNNER DM ERROR:", err.message));

    // Notify the student
    await bot.sendMessage(
      order.user_id,
      "✅ Payment confirmed!\n\n🤝 You can now chat with your Helper — just type any message here and it'll be sent to them.",
      { reply_markup: { inline_keyboard: [[{ text: "✅ End Task", callback_data: `end_${orderId}` }]] } }
    ).catch(err => console.log("USER DM ERROR:", err.message));

    // Send the print file to the printer (printing orders only)
    if (order.category === "Printing" && order.print_file_id) {
      const sent = await sendPrintJobToPrinter(order);
      if (!sent.ok) {
        // Warn the runner so they can follow up manually
        await bot.sendMessage(
          order.runner_id,
          `⚠️ We couldn't send the print file to the printer automatically (Request ID: ${orderId}). Contact ${SUPPORT_EMAIL} and we'll sort it out.`
        ).catch(() => {});
      }
    }

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
