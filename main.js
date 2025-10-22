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

// Conversion µ-law vers PCM16
function mulawToPcm16(mulawByte) {
  const MULAW_BIAS = 33;
  mulawByte = ~mulawByte;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0F;
  let sample = mantissa << (exponent + 3);
  sample += MULAW_BIAS << exponent;
  if (sign !== 0) sample = -sample;
  return sample;
}

// Conversion PCM16 vers µ-law
function pcm16ToMulaw(pcm16) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  let sign = (pcm16 >> 8) & 0x80;
  if (sign !== 0) pcm16 = -pcm16;
  if (pcm16 > MULAW_MAX) pcm16 = MULAW_MAX;
  pcm16 += MULAW_BIAS;
  let exponent = 7;
  for (let exp_mask = 0x4000; (pcm16 & exp_mask) === 0 && exponent > 0; exponent--, exp_mask >>= 1);
  const mantissa = (pcm16 >> (exponent + 3)) & 0x0F;
  const mulawByte = ~(sign | (exponent << 4) | mantissa);
  return mulawByte & 0xFF;
}

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
      
      // Configuration initiale ElevenLabs
      const config = {
        type: 'conversation_initiation_client_data',
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: "Tu es un assistant vocal sympathique."
            },
            first_message: "Bonjour ! Comment puis-je vous aider ?"
          },
          tts: {
            model_id: "eleven_flash_v2_5"
          }
        }
      };
      
      elevenWs.send(JSON.stringify(config));
    });

    elevenWs.on('message', (data) => {
      try {
        // Essayer de parser comme JSON d'abord
        try {
          const msg = JSON.parse(data.toString());
          console.log('📨 ElevenLabs message:', msg.type || 'unknown');
          
          // Si c'est de l'audio dans le JSON
          if (msg.type === 'audio' && msg.audio) {
            const pcm16Audio = Buffer.from(msg.audio, 'base64');
            
            // Conversion PCM16 16kHz → µ-law 8kHz
            const mulawAudio = Buffer.alloc(Math.floor(pcm16Audio.length / 4));
            for (let i = 0, j = 0; i < pcm16Audio.length; i += 4, j++) {
              const sample = pcm16Audio.readInt16LE(i);
              mulawAudio[j] = pcm16ToMulaw(sample);
            }
            
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: mulawAudio.toString('base64')
              }
            }));
          }
        } catch (parseErr) {
          // Si ce n'est pas du JSON, c'est de l'audio brut
          if (Buffer.isBuffer(data)) {
            // Conversion PCM16 16kHz → µ-law 8kHz
            const mulawAudio = Buffer.alloc(Math.floor(data.length / 4));
            for (let i = 0, j = 0; i < data.length; i += 4, j++) {
              const sample = data.readInt16LE(i);
              mulawAudio[j] = pcm16ToMulaw(sample);
            }
            
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: mulawAudio.toString('base64')
              }
            }));
          }
        }
      } catch (err) {
        console.error('❌ Erreur ElevenLabs → Twilio:', err.message);
      }
    });

    elevenWs.on('error', (err) => {
      console.error('❌ Erreur ElevenLabs:', err.message);
    });

    elevenWs.on('close', (code, reason) => {
      console.log(`🔴 ElevenLabs déconnecté (code: ${code}, reason: ${reason})`);
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
            const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
            
            // Conversion µ-law 8kHz → PCM16 16kHz
            const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 4);
            for (let i = 0; i < mulawBuffer.length; i++) {
              const pcm16Sample = mulawToPcm16(mulawBuffer[i]);
              // Upsample: répéter chaque sample 2 fois pour passer de 8kHz à 16kHz
              pcm16Buffer.writeInt16LE(pcm16Sample, i * 4);
              pcm16Buffer.writeInt16LE(pcm16Sample, i * 4 + 2);
            }
            
            // Envoyer l'audio à ElevenLabs
            const audioMessage = {
              user_audio_chunk: pcm16Buffer.toString('base64')
            };
            elevenWs.send(JSON.stringify(audioMessage));
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
      console.error('❌ Erreur traitement message Twilio:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔴 Twilio déconnecté');
    if (elevenWs) {
      elevenWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('❌ Erreur Twilio:', err.message);
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
