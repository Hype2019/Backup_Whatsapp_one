const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const open = require('open');
const sqlite3 = require('sqlite3').verbose();
const axiosRetry = require('axios-retry').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { randomInt } = require('crypto');

require('dotenv').config();

const app = express();
const DOWNLOAD_DIR = './downloads';
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);
  

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');


const CLIENT_ID = process.env.ONEDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.ONEDRIVE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

const db = new sqlite3.Database('./tokens.db');
db.run(`CREATE TABLE IF NOT EXISTS tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);`);

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  shouldRetry: (error) => {
    return error.response && (error.response.status === 500 || error.response.status === 502);
  },
  retryCondition: () => true,
});

function startOAuthServer() {
  app.get('/auth', (req, res) => {
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent('Files.ReadWrite offline_access')}`;
    res.redirect(authUrl);
  });

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    try {
      const tokenResponse = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const { access_token, refresh_token, expires_in } = tokenResponse.data;
      const expires_at = Date.now() + expires_in * 1000;

      db.run('INSERT OR REPLACE INTO tokens (provider, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)',
        ['onedrive', access_token, refresh_token, expires_at]);

      res.send('Autenticação concluída. Você pode fechar esta aba.');
      startBot();
    } catch (e) {
      console.error('Erro na autenticação OAuth:', e.message);
      res.status(500).send('Erro na autenticação.');
    }
  });

  app.listen(3000, () => {
    console.log('Servidor OAuth iniciado em http://localhost:3000');
    try {
        require('open')('http://localhost:3000/auth');
      } catch (err) {
        console.log('Abra o seguinte link para autenticar:', 'http://localhost:3000/auth');
      }
  });
}

async function getValidAccessToken() {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM tokens WHERE provider = ?', ['onedrive'], async (err, row) => {
      if (err || !row) return reject('Token não encontrado');
      if (Date.now() < row.expires_at) return resolve(row.access_token);

      try {
        const tokenResponse = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: row.refresh_token,
          redirect_uri: REDIRECT_URI,
          grant_type: 'refresh_token'
        }), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;
        const expires_at = Date.now() + expires_in * 1000;

        db.run('UPDATE tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE provider = ?',
          [access_token, refresh_token, expires_at, 'onedrive']);

        resolve(access_token);
      } catch (e) {
        reject('Erro ao renovar token: ' + e.message);
      }
    });
  });
}

setInterval(() => {
  getValidAccessToken().catch(err => console.error('Erro ao verificar o token:', err));
}, 1 * 60 * 60 * 1000);

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });
  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
  
    if (qr) {
      console.log('\n📷 Escaneie este QR Code com o WhatsApp:\n');
      require('qrcode-terminal').generate(qr, { small: true });
    }
  
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada. Reconectar?', shouldReconnect);
      if (shouldReconnect) startBot();
    }
  
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso!');
    }
  });
  

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const isImage = msg.message.imageMessage;
    const isGroup = msg.key.remoteJid.endsWith('@g.us');

    if (isImage && isGroup) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });

        const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
        const groupName = sanitize(groupMetadata.subject);

        const timestamp = new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString().replace(/[:.]/g, '-');
        const imageName = msg.message.imageMessage.fileName || 'imagem';
        const finalName = `${imageName}${randomInt(100)}_${timestamp}.jpg`;

        const groupDir = path.join(DOWNLOAD_DIR, groupName);
        if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir);
        const filePath = path.join(groupDir, finalName);

        fs.writeFileSync(filePath, buffer);
        console.log(`Imagem salva: ${filePath}`);

        const accessToken = await getValidAccessToken();
        await uploadToOneDrive(accessToken, groupName, finalName, buffer);
      } catch (err) {
        console.error('Erro ao processar imagem:', err);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function uploadToOneDrive(accessToken, folderName, fileName, buffer) {
  try {
    const uploadUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/WhatsAppImages/${folderName}/${fileName}:/content`;
    await axios.put(uploadUrl, buffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'image/jpeg'
      }
    });
  } catch (e) {
    if (e.response && e.response.status !== 409) {
      throw new Error(`Erro ao criar pasta no OneDrive: ${e.response.message}`);
    }
  }

  console.log(`Upload para o OneDrive concluído: ${folderName}/${fileName}`);
}

function sanitize(name) {
  return name.replace(/[^a-z0-9-_]/gi, '_');
}

startOAuthServer();
