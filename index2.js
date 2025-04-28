const websocket = require("ws");
const port = 8080;
const wss = new websocket.Server({ port });

wss.on("connection", (ws) => {
  console.log("New Connection");
  ws.on("message", (message) => {
    console.log(`Recieved -> ${message}`);
    ws.send(`Hello, you sent -> ${message}`);
  });
  ws.send("Hi there, I am a WebSocket server");
});

console.log("Websocket server started on %s", port);