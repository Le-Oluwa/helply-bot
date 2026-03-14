require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const RUNNER_GROUP_ID = process.env.RUNNER_GROUP_ID;

if (!BOT_TOKEN || !RUNNER_GROUP_ID) {
  console.error("❌ Missing BOT_TOKEN or RUNNER_GROUP_ID");
  process.exit(1);
}

// ================= SUPABASE =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= USER SESSION =================
const userState = {};

console.log("🤖 Helply bot is running...");


// ================= START =================
bot.onText(/\/start/, (msg) => {

  if (msg.chat.type !== "private") return;

  const terms = `
📜 *Helply Terms & Conditions*

1️⃣ Provide accurate task details.
2️⃣ Runners must perform tasks responsibly.
3️⃣ Total cost = Item price + Runner fee + Platform fee.
4️⃣ Helply connects users and runners.
5️⃣ Illegal activities prohibited.
6️⃣ Repeated cancellations may lead to suspension.
7️⃣ Item availability depends on vendors.
8️⃣ Respectful communication required.

Click *Accept* to continue.
`;

  bot.sendMessage(msg.chat.id, terms, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Accept Terms", callback_data: "accept_terms" }]
      ]
    }
  });
});


// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {

  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.chat.id;

  // ================= QUANTITY INPUT =================
  if (userState[userId] && userState[userId].awaitingQuantity) {

    const qty = parseInt(msg.text);

    if (isNaN(qty) || qty <= 0) {
      return bot.sendMessage(userId,"Please enter a valid quantity.");
    }

    const item = userState[userId].selectedItem;

    userState[userId].cart.push({
      name: item.item_name,
      price: item.price,
      qty
    });

    userState[userId].awaitingQuantity = false;

    bot.sendMessage(
      userId,
      `✅ Added *${item.item_name} x${qty}* to cart.`,
      { parse_mode:"Markdown" }
    );

    bot.sendMessage(
      userId,
      "What would you like to do next?",
      {
        reply_markup:{
          inline_keyboard:[
            [{text:"➕ Add Another Item",callback_data:`restaurant_${userState[userId].restaurantId}`}],
            [{text:"🧾 Checkout",callback_data:"checkout"}]
          ]
        }
      }
    );

    return;
  }

  // ================= LOCATION INPUT =================
  if (userState[userId] && userState[userId].awaitingLocation) {

    const location = msg.text;

    const cart = userState[userId].cart;

    let itemsText = "";
    let subtotal = 0;

    cart.forEach(item=>{
      itemsText += `${item.name} x${item.qty}\n`;
      subtotal += item.price * item.qty;
    });

    const runnerFee = 300;
    const helplyFee = 100;
    const total = subtotal + runnerFee + helplyFee;

    const taskId = Math.random().toString(36).substring(2,9);

    await supabase.from("orders").insert([{
      id:taskId,
      user_id:userId.toString(),
      task:itemsText,
      delivery_location:location,
      status:"pending",
      created_at:new Date(),
      updated_at:new Date()
    }]);

    delete userState[userId];

    bot.sendMessage(
      userId,
      `✅ *Order Placed*

🆔 Task ID: \`${taskId}\`
📍 Location: ${location}

Waiting for a runner...`,
      {parse_mode:"Markdown"}
    );

    bot.sendMessage(
      RUNNER_GROUP_ID,
      `🚨 *NEW HELPLY ORDER*

🆔 Task ID: \`${taskId}\`

🧾 Items:
${itemsText}

📍 Location: ${location}
💰 Total: ₦${total}`,
      {
        parse_mode:"Markdown",
        reply_markup:{
          inline_keyboard:[
            [{text:"✅ Accept Task",callback_data:`accept_${taskId}`}]
          ]
        }
      }
    );

    return;
  }

  // ================= CAFETERIA =================
  if (msg.text === "🍛 Cafeteria Runs") {

    const {data:restaurants} = await supabase
      .from("restaurants")
      .select("*");

    if (!restaurants) return;

    const buttons = restaurants.map(r=>[
      {text:r.name,callback_data:`restaurant_${r.id}`}
    ]);

    bot.sendMessage(
      msg.chat.id,
      "🍛 Choose a restaurant:",
      {reply_markup:{inline_keyboard:buttons}}
    );
  }

});


// ================= CALLBACK HANDLER =================
bot.on("callback_query", async (query)=>{

  const data = query.data;
  const userId = query.from.id;

  const runnerName = query.from.first_name;
  const runnerId = query.from.id;

  // ================= TERMS ACCEPT =================
  if (data==="accept_terms"){

    bot.sendMessage(
      userId,
      "🎉 Welcome to *Helply*\n\nWhat do you need today?",
      {
        parse_mode:"Markdown",
        reply_markup:{
          keyboard:[
            ["🍛 Cafeteria Runs"],
            ["🛍 Shopping Mall Runs"],
            ["🏃 Custom Errands"]
          ],
          resize_keyboard:true
        }
      }
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= RESTAURANT =================
  if (data.startsWith("restaurant_")){

    const restaurantId = data.split("_")[1];

    userState[userId] = {
      cart:[],
      restaurantId
    };

    const {data:menu} = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id",restaurantId);

    const buttons = menu.map(item=>[
      {
        text:`${item.item_name} — ₦${item.price}`,
        callback_data:`item_${item.id}`
      }
    ]);

    bot.sendMessage(
      userId,
      "Select item:",
      {reply_markup:{inline_keyboard:buttons}}
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= ITEM =================
  if (data.startsWith("item_")){

    const itemId = data.split("_")[1];

    const {data:item} = await supabase
      .from("menu_items")
      .select("*")
      .eq("id",itemId)
      .single();

    userState[userId].selectedItem = item;
    userState[userId].awaitingQuantity = true;

    bot.sendMessage(
      userId,
      `How many *${item.item_name}* would you like?`,
      {parse_mode:"Markdown"}
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= CHECKOUT =================
  if (data==="checkout"){

    userState[userId].awaitingLocation = true;

    bot.sendMessage(
      userId,
      "📍 Please type your delivery location.\nExample: Room F409"
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= ACCEPT TASK =================
  if (data.startsWith("accept_")){

    const taskId = data.split("_")[1];

    const {data:order} = await supabase
      .from("orders")
      .select("*")
      .eq("id",taskId)
      .single();

    if (!order || order.status==="assigned"){
      return bot.answerCallbackQuery(query.id,{
        text:"Task already taken",
        show_alert:true
      });
    }

    await supabase.from("orders").update({
      status:"assigned",
      runner_name:runnerName,
      runner_id:runnerId.toString()
    }).eq("id",taskId);

    bot.sendMessage(
      order.user_id,
      `🎉 Runner *${runnerName}* accepted your order.`,
      {parse_mode:"Markdown"}
    );

    bot.sendMessage(
      runnerId,
      "Task accepted.",
      {
        reply_markup:{
          inline_keyboard:[
            [{text:"📦 Confirm Delivery",callback_data:`complete_${taskId}`}]
          ]
        }
      }
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= DELIVERY =================
  if (data.startsWith("complete_")){

    const taskId = data.split("_")[1];

    const {data:order} = await supabase
      .from("orders")
      .select("*")
      .eq("id",taskId)
      .single();

    await supabase.from("orders").update({
      status:"delivered"
    }).eq("id",taskId);

    bot.sendMessage(
      order.user_id,
      "📦 Your order has arrived.\nPlease confirm receipt.",
      {
        reply_markup:{
          inline_keyboard:[
            [{text:"✅ Confirm Order Received",callback_data:`userconfirm_${taskId}`}]
          ]
        }
      }
    );

    return bot.answerCallbackQuery(query.id);
  }

  // ================= USER CONFIRM =================
  if (data.startsWith("userconfirm_")){

    const taskId = data.split("_")[1];

    await supabase.from("orders").update({
      status:"completed"
    }).eq("id",taskId);

    bot.sendMessage(userId,"✅ Order completed. Thank you!");

    return bot.answerCallbackQuery(query.id);
  }

});


// ================= ERROR =================
bot.on("polling_error",(err)=>{
  console.log(err.message);
});
