const express = require('express');
const dotenv = require('dotenv');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const client = twilio(accountSid, authToken);

let messages = [];
let connectedClients = {};  // Format: { "whatsapp:+62xxxx": websocket }

// Home route
app.get('/', (req, res) => {
  res.send('Twilio WhatsApp API Server with Native WebSocket is running!');
});

// ** API untuk mengirim pesan ke pengguna WhatsApp **
app.post('/api/send-message', async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ success: false, message: "Parameter 'to' dan 'message' wajib diisi" });
    }

    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

    const twilioMessage = await client.messages.create({
      from: twilioWhatsAppNumber,
      body: message,
      to: formattedTo
    });

    return res.status(200).json({
      success: true,
      data: { sid: twilioMessage.sid, status: twilioMessage.status }
    });
  } catch (error) {
    console.error('Error sending message:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengirim pesan', error: error.message });
  }
});

// ** Webhook untuk menerima pesan dari Twilio **
app.post('/webhook', (req, res) => {
  try {
    console.log('Webhook request received:', req.body);

    const incomingMessage = req.body.Body;
    const from = req.body.From;
    const to = req.body.To;

    const messageData = { from, to, message: incomingMessage, timestamp: new Date() };
    messages.push(messageData);

    console.log('Pesan masuk:', messageData);

    // Kirim pesan ke klien WebSocket yang sesuai
    if (connectedClients[from] && connectedClients[from].readyState === WebSocket.OPEN) {
      connectedClients[from].send(JSON.stringify({
        type: 'newMessage',
        data: messageData
      }));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error handling incoming message:', error);
    res.sendStatus(500);
  }
});

// ** GET: Semua thread chat (daftar nomor yang pernah chatting) **
app.get("/threads", (req, res) => {
  const threads = {};

  messages.forEach(({ from, to, message, timestamp }) => {
    const chatPartner = from !== twilioWhatsAppNumber ? from : to;
    if (!threads[chatPartner]) {
      threads[chatPartner] = { phone: chatPartner, lastMessage: message, timestamp };
    }
  });

  const threadList = Object.values(threads).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  res.json({ success: true, threads: threadList });
});

// ** GET: Semua pesan dari nomor tertentu **
app.get("/messages/:phone", (req, res) => {
  const { phone } = req.params;
  const chatMessages = messages.filter(msg => msg.from === phone || msg.to === phone);

  res.json({ success: true, messages: chatMessages });
});

// ** WebSocket Server **
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');
  
  // Kirim pesan selamat datang
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to Twilio WhatsApp WebSocket Server'
  }));

  // ** Terima pesan dari client **
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle register event
      if (data.type === 'register' && data.phoneNumber) {
        const phoneNumber = data.phoneNumber;
        connectedClients[phoneNumber] = ws;
        console.log(`Client dengan nomor ${phoneNumber} terhubung.`);
        
        // Konfirmasi registrasi berhasil
        ws.send(JSON.stringify({
          type: 'registered',
          phoneNumber: phoneNumber
        }));
      }
      
      // Handle message event untuk dikirim ke Twilio
      else if (data.type === 'message') {
        console.log(`Menerima permintaan kirim pesan melalui WebSocket:`, data.data.message);

        // const formattedTo = data.data.to.startsWith('whatsapp:') ? data.data.to : `whatsapp:${data.data.to}`;
        // const messageToForward = messageData.data.message;
        // Gunakan API client Twilio yang sudah ada
        client.messages.create({
          from: twilioWhatsAppNumber,
          body: data.data.message,
          to: 'whatsapp:+6285219486369'
        })
        .then(twilioMessage => {
          // console.log(`Pesan berhasil dikirim ke ${formattedTo}, SID: ${twilioMessage.sid}`);
          // Tambahkan ke riwayat pesan
          const messageData = {
            from: twilioWhatsAppNumber,
            to: 'whatsapp:+6285219486369',
            message: data.data.message,
            timestamp: new Date()
          };
          messages.push(messageData);
          
          // Konfirmasi ke pengirim bahwa pesan sudah dikirim
          // ws.send(JSON.stringify({
          //   type: 'messageSent',
          //   data: messageData,
          //   sid: twilioMessage.sid
          // }));
        })
        .catch(error => {
          console.error('Error mengirim pesan ke Twilio:', error);
          
          // Kirim notifikasi error ke pengirim
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Gagal mengirim pesan',
            details: error.message
          }));
        });
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  // ** Handle disconnect **
  ws.on('close', () => {
    // Cari nomor telepon yang terkait dengan koneksi ini
    const phoneNumber = Object.keys(connectedClients).find(
      key => connectedClients[key] === ws
    );

    if (phoneNumber) {
      delete connectedClients[phoneNumber];
      console.log(`Client dengan nomor ${phoneNumber} terputus.`);
    }
  });
});
// ** Start server **
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  console.log(`Webhook URL: https://your-ngrok-url.ngrok-free.app/webhook`);
  console.log(`WebSocket URL: wss://your-ngrok-url.ngrok-free.app`);
});