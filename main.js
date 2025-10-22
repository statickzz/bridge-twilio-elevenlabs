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
  // let callSid = null; // Pas nécessaire ici

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
      
      // <-- MODIFIÉ : Il faut envoyer la configuration audio !
      const initialConfig = {
        "provider": "twilio",
        "format": {
          "type": "pcm",
          "sample_rate": 16000 // On va lui envoyer du 16kHz
        }
      };
      elevenWs.send(JSON.stringify(initialConfig));
      console.log('📨 Config audio envoyée à ElevenLabs');
    });

    elevenWs.on('message', (message) => { // <-- MODIFIÉ : 'message' est plus sûr que 'data'
      try {
        // <-- MODIFIÉ : ElevenLabs envoie du JSON, pas des buffers bruts
        const data = JSON.parse(message);
        
        if (data.type === 'audio' && data.audio) {
          // Audio depuis ElevenLabs (PCM 16kHz) → Twilio (µ-law 8kHz)
          const pcm16Buffer = Buffer.from(data.audio, 'base64');
          
          // Conversion
          const pcm16Downsampled = downsample(pcm16Buffer, 16000, 8000); // <-- MODIFIÉ
          const ulawBuffer = pcmToUlaw(pcm16Downsampled); // <-- MODIFIÉ
          const audioPayload = ulawBuffer.toString('base64');
          
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: audioPayload
              }
            }));
          }
        } else if (data.type) {
            console.log(`📨 ElevenLabs message: ${data.type}`);
        }

      } catch (err) {
        console.error('❌ Erreur ElevenLabs → Twilio:', err);
      }
    });

    elevenWs.on('error', (err) => {
      console.error('❌ Erreur ElevenLabs:', err.message);
    });

    elevenWs.on('close', (code, reason) => { // <-- MODIFIÉ : Ajout des logs
      console.log(`🔴 ElevenLabs déconnecté (code: ${code}, reason: ${reason.toString()})`);
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'stop', streamSid: streamSid }));
      }
    });
  }

  // Messages depuis Twilio
  twilioWs.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        // <-- MODIFIÉ : L'événement de Twilio s'appelle 'connected', pas 'start'
        case 'connected': 
          streamSid = msg.streamSid;
          // callSid = msg.callSid; // callSid est dans msg.start, mais pas besoin
          console.log(`🟢 Stream démarré: ${streamSid}`);
          
          // Connexion à ElevenLabs maintenant
          connectToElevenLabs();
          break;

        case 'media':
          // Audio depuis Twilio (µ-law 8kHz) → ElevenLabs (PCM 16kHz)
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            const ulawBuffer = Buffer.from(msg.media.payload, 'base64');
            
            // <-- MODIFIÉ : Conversion audio
            const pcm16Buffer = ulawToPcm(ulawBuffer);
            const pcm16Upsampled = upsample(pcm16Buffer, 8000, 16000);
            
            // <-- MODIFIÉ : Envoyer en JSON
            elevenWs.send(JSON.stringify({
              "type": "audio_input",
              "audio": pcm16Upsampled.toString('base64')
            }));
          }
          break;

        case 'stop':
          console.log('🛑 Stream arrêté par Twilio');
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            elevenWs.close(1000, 'Twilio stream stopped');
          }
          break;
      }
    } catch (err) {
      console.error('❌ Erreur traitement message Twilio:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔴 Twilio déconnecté');
    if (elevenWs && elevenWs.readyState !== WebSocket.CLOSED) {
      elevenWs.close(1000, 'Twilio connection closed');
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


// --- Fonctions de conversion audio ---
// <-- MODIFIÉ : Tout ce bloc est nécessaire

// Convertir µ-law (Buffer) en PCM 16-bit (Buffer)
function ulawToPcm(ulawBuffer) {
  const pcmBuffer = Buffer.alloc(ulawBuffer.length * 2);
  for (let i = 0; i < ulawBuffer.length; i++) {
    const ulawByte = ulawBuffer[i];
    let biased = (ulawByte ^ 0xFF) | 0x80;
    if (biased < 0) biased = biased + 256;
    if (biased > 255) biased = biased - 256;
    
    let sign = (biased & 0x80) === 0 ? -1 : 1;
    let exponent = (biased >> 4) & 0x07;
    let mantissa = biased & 0x0F;
    let sample = (mantissa << 4) + 8;
    sample = (sample << (exponent + 3));
    sample = (exponent === 0) ? (sample - 132) : (sample + 132);
    sample = (sample * sign);
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  return pcmBuffer;
}

// Convertir PCM 16-bit (Buffer) en µ-law (Buffer)
function pcmToUlaw(pcmBuffer) {
  const ulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
  const bias = 0x84;
  const maxSample = 32635;

  for (let i = 0; i < ulawBuffer.length; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    let sign = (sample < 0) ? 0x00 : 0x80;
    
    sample = Math.abs(sample);
    if (sample > maxSample) sample = maxSample;
    sample += bias;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let ulawByte = (sign | (exponent << 4) | mantissa);
    ulawBuffer[i] = ulawByte ^ 0xFF;
  }
  return ulawBuffer;
}

// Ré-échantillonnage simple (interpolation linéaire)
function upsample(buffer, inputRate, outputRate) {
  if (inputRate === outputRate) return buffer;
  
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(buffer.length / 2 * (outputRate / inputRate));
  const outputBuffer = Buffer.alloc(outputLength * 2);

  for (let i = 0; i < outputLength; i++) {
    const inIndexFloat = i * ratio;
    const inIndexInt = Math.floor(inIndexFloat);
    const frac = inIndexFloat - inIndexInt;
    const inIndex1 = Math.min(inIndexInt, (buffer.length / 2) - 2);
    const inIndex2 = inIndex1 + 1;
    const sample1 = buffer.readInt16LE(inIndex1 * 2);
    const sample2 = buffer.readInt16LE(inIndex2 * 2);
    const outputSample = sample1 + (sample2 - sample1) * frac;
    outputBuffer.writeInt16LE(Math.round(outputSample), i * 2);
  }
  return outputBuffer;
}

// Downsampling (plus simple, on prend 1 échantillon sur N)
function downsample(buffer, inputRate, outputRate) {
    if (inputRate === outputRate) return buffer;

    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(buffer.length / 2 / ratio);
    const outputBuffer = Buffer.alloc(outputLength * 2);

    for (let i = 0; i < outputLength; i++) {
        const inIndex = Math.floor(i * ratio);
        const sample = buffer.readInt16LE(inIndex * 2);
        outputBuffer.writeInt16LE(sample, i * 2);
    }
    return outputBuffer;
}
