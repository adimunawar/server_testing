const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;
const axios = require('axios');
const admin = require('firebase-admin');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
// Parse application/json
app.use(bodyParser.json());

// Konfigurasi WhatsApp Business Accounts
const WA_CONFIGS = {
  
};

const VERIFY_TOKEN = 'omni_channel_testing_bwang';

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(require('./waktoo-crm-7505d-firebase-adminsdk-fbsvc-8e2dff4dba.json')),
});

// Akses Firestore
const db = admin.firestore();

// Webhook verifikasi
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook untuk pesan masuk dan status
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    if (!body.object || !body.entry?.[0]?.changes?.[0]?.value) {
      return res.sendStatus(400);
    }

    const value = body.entry[0].changes[0].value;
    const phoneNumberId = value.metadata.phone_number_id;
    const config = await getWaConfig(phoneNumberId);

    if (!config) {
      console.error(`No WA config found for phone_number_id: ${phoneNumberId}`);
      return res.sendStatus(400);
    }
    
    const waBusinessId = phoneNumberId; // karena ID = phone_number_id

    if (value.messages) {
      const messages = value.messages;
      const metadata = value.metadata;
      const contact = value.contacts?.[0];
      for (const message of messages) {
        await handleIncomingMessage( config , message, metadata, contact);
      }
    } else if (value.statuses) {
      const statuses = value.statuses;
      for (const status of statuses) {
        await handleMessageStatus(waBusinessId, status);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

// Endpoint untuk mengirim pesan teks
app.post('/send-message', async (req, res) => {
  try {
    const { waBusinessId, recipientNumber, messageText, contactName } = req.body;
    if (!waBusinessId || !recipientNumber || !messageText) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const result = await sendTextMessage(waBusinessId, recipientNumber, messageText, contactName);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Endpoint untuk mengupload dan mengirim media
app.post('/upload-media', upload.single('media'), async (req, res) => {
  try {
    const { waBusinessId, recipientNumber, mediaType, contactName, caption } = req.body;
    const mediaFile = req.file;

    if (!waBusinessId || !recipientNumber || !mediaType || !mediaFile) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const config = WA_CONFIGS[waBusinessId];
    if (!config) {
      return res.status(400).json({ error: `Invalid WA Business ID: ${waBusinessId}` });
    }

    // Upload media ke Meta
    const form = new FormData();
    form.append('file', fs.createReadStream(mediaFile.path));
    form.append('type', "image/jpeg"); // bisa disesuaikan dengan file.mimetype kalau dinamis
    form.append('messaging_product', 'whatsapp');

    const uploadResponse = await axios.post(
      `https://graph.facebook.com/v22.0/${config.phone_number_id}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${config.access_token}`,
          ...form.getHeaders(),
        },
      }
    );

    const mediaId = uploadResponse.data.id;
    if (!mediaId) {
      throw new Error('No media ID returned');
    }

    // Kirim pesan media ke WhatsApp
    const mediaPayload = {
      messaging_product: 'whatsapp',
      to: recipientNumber,
      type: mediaType,
      [mediaType]: {
        id: mediaId,
        ...(caption ? { caption } : {}), // tambahkan caption jika ada
      },
    };

    const sendResponse = await axios.post(
      `https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`,
      mediaPayload,
      {
        headers: {
          Authorization: `Bearer ${config.access_token}`,
        },
      }
    );

    const wamid = sendResponse.data.messages?.[0]?.id;
    if (!wamid) {
      throw new Error('No message ID returned');
    }

    // Simpan ke Firestore
    const threadId = await getOrCreateThread(
      waBusinessId,
      recipientNumber,
      contactName || 'Unknown',
      caption ? caption : `Media: ${mediaType}`
    );

    const newChatDocRef = db.collection('wa_chat_test').doc();
    await newChatDocRef.set({
      id: newChatDocRef.id,
      thread: threadId,
      sender: config.display_phone_number,
      message: caption || '',
      media_id: mediaId,
      media_type: mediaType,
      wamid: wamid,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      unread: false,
    });

    fs.unlinkSync(mediaFile.path); // hapus file setelah upload

    res.status(200).json({ success: true, wamid });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error in upload-media:', error.message);
    res.status(500).json({ error: 'Failed to send media' });
  }
});


// Endpoint untuk mendapatkan URL media sementara
app.get('/media/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { waBusinessId } = req.query;

    if (!waBusinessId) {
      return res.status(400).json({ error: 'waBusinessId is required' });
    }

    const config = await getWaConfig(waBusinessId);
    if (!config) {
      return res.status(400).json({ error: 'Invalid WA Business ID' });
    }

    // Get the media metadata from Graph API (to get actual URL)
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v20.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${config.access_token}` },
      }
    );

    
    const fileUrl = mediaResponse.data.url;
    if (!fileUrl) {
      return res.status(404).json({ error: 'Media URL not found or expired' } );
    }

    // Use GET request instead of HEAD to get mime-type (HEAD may fail)
    const fileResponse = await axios.get(fileUrl, {
      headers: {Authorization: `Bearer ${config.access_token}`},
      responseType: 'stream',
    });

    const mimeType = fileResponse.headers['content-type'];

    const proxiedUrl = `${req.protocol}://${req.get('host')}/media-proxy/${mediaId}?waBusinessId=${waBusinessId}`;

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      url: proxiedUrl,
      mime_type: mimeType,
    });
  } catch (error) {
    console.error('Error fetching media metadata:', error.message);
    const status = error.response?.status || 500;
    res.status(status).json({
      error: error.response?.data?.error?.message || 'Failed to fetch media metadata',
    });
  }
});



app.get('/media-proxy/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { waBusinessId } = req.query;

    if (!waBusinessId) {
      return res.status(400).json({ error: 'waBusinessId is required' });
    }

    const config = await getWaConfig(waBusinessId);
    if (!config) {
      return res.status(400).json({ error: 'Invalid WA Business ID' });
    }

    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v20.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${config.access_token}` } }
    );

    const fileUrl = mediaResponse.data.url;
    if (!fileUrl) {
      return res.status(404).json({ error: 'Media URL not found or expired' });
    }

    const fileStream = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${config.access_token}`,
      },
    });

    res.setHeader('Content-Type', fileStream.headers['content-type']);
    res.setHeader('Content-Length', fileStream.headers['content-length']);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // optional cache
    fileStream.data.pipe(res);
  } catch (error) {
    console.error('Error proxying media file:', error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.error?.message || 'Failed to proxy media file' });
  }
});

app.post('/wa-configs_test', async (req, res) => {
  const {
    phone_number_id,
    display_phone_number,
    access_token,
    participants
  } = req.body;

  if (!phone_number_id || !display_phone_number || !access_token || !participants) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }

  try {
    const configRef = db.collection('wa_configs').doc(phone_number_id);

    await configRef.set({
      phone_number_id,
      display_phone_number,
      access_token,
      participants
    });

    res.status(201).json({ message: 'WA Config berhasil disimpan' });
  } catch (err) {
    console.error('Error saat menyimpan WA Config:', err);
    res.status(500).json({ error: 'Gagal menyimpan WA Config' });
  }
});

// Handle pesan masuk
async function handleIncomingMessage(waConfig, message, metadata = {}, contact = {}) {
  const from = message.from;
  const wamid = message.id;
  const contactWaId = contact.wa_id;

  if (!from || !waConfig) return;

  let text = message.text?.body || '';
  let mediaId = '';
  let mediaType = '';

  if (['image', 'video', 'document', 'audio'].includes(message.type)) {
    mediaType = message.type;
    mediaId = message[mediaType]?.id || '';
    text = message[mediaType]?.caption || '';
    console.log(`Received media: ${mediaType}, ID: ${mediaId}`);
    console.log(`Received media: ${message}`);
  }

  const phoneId = waConfig.phone_number_id;
  const threadId = await getOrCreateThread(phoneId,waConfig, contactWaId, contact?.profile?.name || 'Unknown', text || `Media: ${mediaType}`);

  const newChatDocRef = db.collection('wa_chat_test').doc();
  await newChatDocRef.set({
    id: newChatDocRef.id,
    thread: threadId,
    sender: contactWaId,
    message: text,
    media_id: mediaId,
    media_type: mediaType,
    wamid: wamid,
    created_at: Date.now(),
    unread: true,
  });

  console.log(`Saved message for thread ${threadId}, wamid ${wamid}`);
}


// Handle status pesan (read)
async function handleMessageStatus(waBusinessId, status) {
  const wamid = status.id;
  const statusType = status.status;
  if (statusType === 'read') {
    const chatQuery = await db.collection('wa_chat_test').where('wamid', '==', wamid).limit(1).get();
    if (!chatQuery.empty) {
      await chatQuery.docs[0].ref.update({
        unread: false,
        updated_at: Date.now(),
      });
      console.log(`Chat wamid ${wamid} marked as read`);
    }
  }
}

// Kirim pesan teks
async function sendTextMessage(waBusinessId, recipientNumber, messageText, contactName) {
  const config = await getWaConfig(waBusinessId);
  if (!config) throw new Error(`Invalid WA Business ID`);

  contactName = contactName || 'Unknown';

  let response;
  try {
    response = await axios.post(
      `https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientNumber,
        text: { body: messageText },
      },
      { headers: { Authorization: `Bearer ${config.access_token}` } }
    );
  } catch (error) {
    console.error('Failed to send message to WhatsApp:', error.response?.data || error.message);
    throw error;
  }

  const wamid = response.data.messages?.[0]?.id;
  if (!wamid) throw new Error('No message ID returned');

  const threadId = await getOrCreateThread(waBusinessId, config, recipientNumber, contactName, messageText);

  const newChatDocRef = db.collection('wa_chat_test').doc();
  await newChatDocRef.set({
    id: newChatDocRef.id,
    thread: threadId,
    sender: config.display_phone_number,
    message: messageText,
    media_id: '',
    media_type: '',
    wamid: wamid,
    created_at: Date.now(),
    unread: true,
  });

  console.log(`Message sent. WAMID: ${wamid}, ThreadID: ${threadId}`);

  return response.data;
}

// Helper untuk thread
async function getOrCreateThread(waBusinessId, waConfig, contactWaId, contactName, lastMessage) {
  const threadCollection = db.collection('wa_thread_test');
  const timestamp = Date.now();

  // Ambil semua thread yang cocok, lalu filter aktif di client-side
  const existingThreadQuery = await threadCollection
    .where('wa_business_id', '==', waBusinessId)
    .where('contact_wa_id', '==', contactWaId)
    .get();

  const activeThreadDoc = existingThreadQuery.docs.find(
    doc => doc.data().status !== 2
  );

  if (activeThreadDoc) {
    await activeThreadDoc.ref.update({
      last_message: lastMessage,
      last_updated: timestamp
    });
    return activeThreadDoc.id;
  }

  // Jika tidak ada thread aktif, buat baru
  const newThreadRef = await threadCollection.add({
    wa_business_id: waBusinessId,
    display_phone_number: waConfig.display_phone_number,
    contact_name: contactName,
    contact_wa_id: contactWaId,
    last_message: lastMessage,
    last_updated: timestamp,
    status: 0, // status aktif
  });

  return newThreadRef.id;
}



async function getWaConfig(phoneNumberId) {
  const docRef = db.collection('wa_configs').doc(phoneNumberId);
  const doc = await docRef.get();

  if (!doc.exists) {
    console.log('No config found for phone_number_id:', phoneNumberId);
    return null;
  }
  
  // console.log('No config found for phone_number_id:',doc.data());
  return doc.data(); // bisa juga return { id: doc.id, ...doc.data() } kalau perlu ID-nya juga
}


// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});