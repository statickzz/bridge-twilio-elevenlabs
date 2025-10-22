const WebSocket = require('ws');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

// Clé API ElevenLabs depuis les variables d'environnement
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_AGENT = process.env.ELEVENLABS_AGENT_ID || "agent_1301k74qw8j2f40v41zh4hxajay2";

// Serveur WebSocket
const wss = new WebSocket.Server({ noServer: true });

// Endpoint de santé pour Render
app.get('/health', (req, res) => {
  res.send('OK');
});

// Gestion des connexions WebSocket
wss.on('connection', (twilioWs, request) => {
  console.log('📞 Twilio connecté');
  
  let elevenWs = null;
  let streamSid = null;
  let callSid = null;

  // Connexion à ElevenLabs
  function connectToElevenLabs() {
    const elevenUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVEN_AGENT}`;
    
    elevenWs = new WebSocket(elevenUrl, {
      headers: {
        'xi-api-key': ELEVEN_KEY
      }
    });

    elevenWs.on('open', () => {
      console.log('🤖 ElevenLabs connecté');
    });

    elevenWs.on('message', (data) => {
      try {
        // ElevenLabs envoie de l'audio brut ou des messages JSON
        if (Buffer.isBuffer(data)) {
          // Audio depuis ElevenLabs → Twilio
          const audioPayload = data.toString('base64');
          
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: audioPayload
            }
          }));
        } else {
          // Messages de contrôle ElevenLabs
          console.log('📨 ElevenLabs:', data.toString());
        }
      } catch (err) {
        console.error('❌ Erreur ElevenLabs → Twilio:', err);
      }
    });

    elevenWs.on('error', (err) => {
      console.error('❌ Erreur ElevenLabs:', err);
    });

    elevenWs.on('close', () => {
      console.log('🔴 ElevenLabs déconnecté');
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
    });
  }

  // Messages depuis Twilio
  twilioWs.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log(`🟢 Stream démarré: ${streamSid}`);
          
          // Connexion à ElevenLabs maintenant
          connectToElevenLabs();
          break;

        case 'media':
          // Audio depuis Twilio → ElevenLabs
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            elevenWs.send(audioBuffer);
          }
          break;

        case 'stop':
          console.log('🛑 Stream arrêté');
          if (elevenWs) {
            elevenWs.close();
          }
          break;
      }
    } catch (err) {
      console.error('❌ Erreur traitement message Twilio:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔴 Twilio déconnecté');
    if (elevenWs) {
      elevenWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('❌ Erreur Twilio:', err);
  });
});

// Serveur HTTP + upgrade WebSocket
const server = app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});