const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;
const axios = require('axios');
// Parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
// Parse application/json
app.use(bodyParser.json());
const admin = require('firebase-admin');
// Konfigurasi WhatsApp Business Accounts (tambahkan lebih banyak sesuai kebutuhan)
const WA_CONFIGS = {
  'WA_BUSINESS_ID': {
    phone_number_id: 'WA_BUSINESS_ID', // Ganti dengan PHONE_NUMBER_ID Anda
    display_phone_number:'62....',
    access_token: 'ACCESS_TOKEN', // Ganti dengan ACCESS_TOKEN Anda
  },
};
const VERIFY_TOKEN = 'omni_channel_testing_bwang';
admin.initializeApp({
  credential: admin.credential.cert(require('./waktoo-crm-7505d-firebase-adminsdk-fbsvc-0c93e91780.json')),
});

// Akses Firestore
const db = admin.firestore();
// Endpoint untuk webhook
app.get('/webhook', (req, res) => {
  // Mode dan token untuk verifikasi dari Meta
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Cek mode dan token yang dikirim
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    // Respond dengan challenge untuk memverifikasi webhook
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    // Respond dengan '403 Forbidden' jika token verifikasi tidak cocok
    res.sendStatus(403);
  }
});


// Handle pesan masuk dari WA
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages) {
      return res.sendStatus(400);
    }
    const value = body.entry[0].changes[0].value;
    const phoneNumberId = value.metadata.phone_number_id;
    const waBusinessId = Object.keys(WA_CONFIGS).find((id) => WA_CONFIGS[id].phone_number_id === phoneNumberId);
    const messages = value.messages;
    const metadata = value.metadata;
    const contact = value.contacts?.[0];
    for (const message of messages) {
      await handleIncomingMessage(waBusinessId, message, metadata, contact);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
  // const body = req.body;
  // console.log("Webhook received:", JSON.stringify(body, null, 2));
  // if (body.object) {
  //   const entry = body.entry?.[0];
  //   const changes = entry?.changes?.[0];
  //   const value = changes?.value;

  //   if (value?.messages) {
  //     const message = value.messages[0];
  //     const from = message.from;
  //     const text = message.text?.body;

  //     console.log(`Pesan dari ${from}: ${text}`);
  //   }

  //   res.sendStatus(200);
  // } else {
  //   res.sendStatus(404);
  // }
});

// Endpoint untuk mengirim pesan (testing)
app.post('/send-message', async (req, res) => {
  try {
    const { waBusinessId, recipientNumber, messageText, contactName } = req.body;
    if (!waBusinessId || !recipientNumber || !messageText) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const result = await sendMessage(waBusinessId, recipientNumber, messageText, contactName);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});


// Tangani pesan masuk dari webhook dan simpan ke Firebase
async function handleIncomingMessage(waBusinessId, message, metadata = {}, contact = {}) {
  const from = message.from;
  const text = message.text?.body;
  if (!from || !text || !WA_CONFIGS[waBusinessId]) return;

  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const threadCollection = db.collection('wa_thread_test');
  const chatCollection = db.collection('wa_chat_test');
  const contactWaId = contact.wa_id;

  const existingThreadQuery = await threadCollection
    .where('wa_business_id', '==', waBusinessId)
    .where('contact_wa_id', '==', contactWaId)
    .limit(1)
    .get();

  let threadId;
  if (!existingThreadQuery.empty) {
    const threadDoc = existingThreadQuery.docs[0];
    const threadData = threadDoc.data();
    if (threadData.status !== 2) {
      await threadDoc.ref.update({
        last_message: text,
        last_updated: timestamp,
      });
      threadId = threadDoc.id;
    } else {
      const newThreadRef = await threadCollection.add({
        wa_business_id: waBusinessId,
        display_phone_number: metadata.display_phone_number,
        contact_name: contact?.profile?.name || 'Unknown',
        contact_wa_id: contactWaId,
        last_message: text,
        last_updated: timestamp,
        status: 0,
      });
      threadId = newThreadRef.id;
    }
  } else {
    const newThreadRef = await threadCollection.add({
      wa_business_id: waBusinessId,
      display_phone_number: metadata.display_phone_number,
      contact_name: contact?.profile?.name || 'Unknown',
      contact_wa_id: contactWaId,
      last_message: text,
      last_updated: timestamp,
      status: 0,
    });
    threadId = newThreadRef.id;
  }

  // Buat dokumen chat baru dengan ID otomatis
  const newChatDocRef = chatCollection.doc();
  await newChatDocRef.set({
    id: newChatDocRef.id,
    thread: threadId,
    sender: contactWaId,
    message: text,
    created_at: timestamp,
    unread: true,
  });

  console.log(`Incoming message saved for thread ${threadId} with chat ID ${newChatDocRef.id}`);
}


// Fungsi untuk mengirim notifikasi

// Kirim pesan WhatsApp dan simpan ke Firebase
async function sendMessage(waBusinessId, recipientNumber, messageText, contactName = 'Unknown') {
  try {
    const config = WA_CONFIGS[waBusinessId];
    if (!config) throw new Error(`Invalid WA Business ID: ${waBusinessId}`);
    // Kirim pesan via WhatsApp API
    const response = await axios.post(
      `https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientNumber,
        text: { body: messageText },
      },
      {
        headers: {
          Authorization: `Bearer ${config.access_token}`,
        },
      }
    );
    //disini harus ada pengecekan berhasil atau tidaknya kirim ke wa api
    

    // Simpan ke Firebase
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const threadCollection = db.collection('wa_thread_test');
    const chatCollection = db.collection('wa_chat_test');

    const existingThreadQuery = await threadCollection
      .where('wa_business_id', '==', waBusinessId)
      .where('contact_wa_id', '==', recipientNumber)
      .limit(1)
      .get();

    let threadId;

    if (!existingThreadQuery.empty) {
      const threadDoc = existingThreadQuery.docs[0];
      const threadData = threadDoc.data();

      if (threadData.status !== 2) {
        await threadDoc.ref.update({
          last_message: messageText,
          last_updated: timestamp,
        });
        threadId = threadDoc.id;
      } else {
        const newThreadRef = await threadCollection.add({
          wa_business_id: waBusinessId,
          display_phone_number: config.display_phone_number, // pakai dari config
          contact_name: contactName,
          contact_wa_id: recipientNumber,
          last_message: messageText,
          last_updated: timestamp,
          status: 0,
        });
        threadId = newThreadRef.id;
      }
    } else {
      const newThreadRef = await threadCollection.add({
        wa_business_id: waBusinessId,
        display_phone_number: config.display_phone_number, // fallback
        contact_name: contactName,
        contact_wa_id: recipientNumber,
        last_message: messageText,
        last_updated: timestamp,
        status: 0,
      });
      threadId = newThreadRef.id;
    }
    const newChatDocRef = chatCollection.doc();
    await newChatDocRef.set({
      id: newChatDocRef.id,
      thread: threadId,
      sender: config.display_phone_number,
      message: messageText,
      created_at: timestamp,
      unread: false, // karena ini pesan dari kita
    });

    
    console.log(`Message sent and saved for thread ${threadId}`);
    return response.data;
  } catch (error) {
    console.error('Error sending message:', error.message);
    throw error;
  }
}


// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});