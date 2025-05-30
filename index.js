const crypto = require('crypto');
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

db.run(`CREATE TABLE IF NOT EXISTS upload_logs (
  file_path TEXT PRIMARY KEY,
  last_uploaded INTEGER NOT NULL,
  last_modified INTEGER NOT NULL
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
        getValidAccessToken();
        startBot();
      } catch(e){
        try{
        require('open')('http://localhost:3000/auth');
        
      } catch (err) {
        console.log('Abra o seguinte link para autenticar:', 'http://localhost:3000/auth');
      }}
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

function getGroupLogPath(groupName) {
  const groupDir = path.join(DOWNLOAD_DIR, groupName);
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
  return path.join(groupDir, 'mensagens.txt');
}

async function UploadAllLogs() {
  const groupDirs = fs.readdirSync(DOWNLOAD_DIR).filter((name) => {
    return fs.statSync(path.join(DOWNLOAD_DIR, name)).isDirectory();
  });

  for (const groupName of groupDirs) {
    const logPath = path.join(DOWNLOAD_DIR, groupName, 'mensagens.txt');
    if (!fs.existsSync(logPath)) continue;

    const modified = await wasFileModified(logPath);
    if (!modified) continue;

    if (!fs.existsSync(logPath)) continue;

    try {
      const accessToken = await getValidAccessToken();
      const uploadUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/WhatsAppImages/${groupName}/mensagens.txt:/content`;

      await axios.put(uploadUrl, fs.readFileSync(logPath), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/text'
        }
      });

      updateUploadLog(logPath);
      console.log(`📤 Histórico do grupo "${groupName}" enviado com sucesso.`);
    } catch (err) {
      console.error(`❌ Erro ao enviar ZIP do grupo "${groupName}":`, err.message);
    }
  }
}

setInterval(UploadAllLogs, 3 * 60 * 60 * 1000);
UploadAllLogs();

function sanitize(name) {
  return name.replace(/[^a-z0-9-_]/gi, '_');
}

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

    const mediaTypes = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'documentWithCaptionMessage'];
    const mediaType = mediaTypes.find(type => msg.message[type]);
    const isMedia = !!mediaType;
    const isGroup = msg.key.remoteJid.endsWith('@g.us');

    const timestamp = new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString();

    if (isMedia && isGroup) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
      
          const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
          const groupName = sanitize(groupMetadata.subject);
      
          const timestamp = new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString();
          const sender = msg.pushName || msg.key.participant || msg.key.remoteJid;
      
          // Determina nome de arquivo com base no tipo
          let extension = '';
          let defaultName = 'arquivo';
      
          switch (mediaType) {
            case 'imageMessage':
              extension = '.jpg';
              defaultName = msg.message.imageMessage.fileName || 'imagem';
              break;
            case 'audioMessage':
              extension = '.ogg';
              defaultName = 'audio';
              break;
            case 'videoMessage':
              extension = '.mp4';
              defaultName = msg.message.videoMessage.fileName || 'video';
              break;
            case 'documentMessage':
              extension = msg.message.documentMessage.fileName
                ? path.extname(msg.message.documentMessage.fileName)
                : '.pdf';
              defaultName = msg.message.documentMessage.fileName
                ? path.basename(msg.message.documentMessage.fileName, extension)
                : 'documento';
              break;
            case 'documentWithCaptionMessage':
                extension = msg.message.documentWithCaptionMessage.message.documentMessage.fileName
                  ? path.extname(msg.message.documentWithCaptionMessage.message.documentMessage.fileName)
                  : '.pdf';
                defaultName = msg.message.documentWithCaptionMessage.message.documentMessage.fileName
                  ? path.basename(msg.message.documentWithCaptionMessage.message.documentMessage.fileName, extension)
                  : 'documento';
                break;
          }
      
          const finalName = `${sanitize(defaultName)}${randomInt(100)}_${timestamp.replace(/[:.]/g, '-')}${extension}`;
          const groupDir = path.join(DOWNLOAD_DIR, groupName);
          if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir);
          // const filePath = path.join(groupDir, finalName)

          // fs.writeFileSync(filePath, buffer);
          // console.log(`📥 Mídia salva: ${filePath}`);
      
          const logPath = getGroupLogPath(groupName);
          const logLine = `[${timestamp}] ${sender}: ${finalName}\n`;
          fs.appendFileSync(logPath, logLine);
          
          let caption = '';

          try {
            caption =
              msg.message.imageMessage?.caption ||
              msg.message.videoMessage?.caption ||
              msg.message.audioMessage?.caption ||
              msg.message.documentWithCaptionMessage?.message.documentMessage.caption ||
              msg.message.conversation ||
              msg.message.extendedTextMessage?.text ||
              '';
          } catch (e) {
            console.error('❌ Erro ao extrair legenda:', e);
            caption = '';
          }
          
          if (caption && typeof caption === 'string') {
            const logLineCaption = `[${timestamp}] ${sender} (legenda da mídia: ${finalName}): ${caption}\n`;
            fs.appendFileSync(logPath, logLineCaption);
          }
          
          const accessToken = await getValidAccessToken();
          await uploadToOneDrive(accessToken, groupName, finalName, buffer);
        } catch (err) {
          console.error('❌ Erro ao processar mídia:', err);
        }
      }
      

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (text && isGroup) {
      const groupMetadata = isGroup ? await sock.groupMetadata(msg.key.remoteJid) : null;
      const groupName = isGroup ? sanitize(groupMetadata.subject) : 'Privado';
      const logPath = getGroupLogPath(groupName);

      const sender = msg.pushName || msg.key.participant || msg.key.remoteJid;

      var logLine = `[${timestamp}] ${sender}: ${msg.message.conversation || msg.message.extendedTextMessage?.text}\n`;
      fs.appendFileSync(logPath, logLine);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function uploadToOneDrive(accessToken, groupName, fileName, buffer) {
    const ext = path.extname(fileName).toLowerCase();
  
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
      '.kml': 'application/vnd.google-earth.kml+xml',
      '.kmz': 'application/vnd.google-earth.kmz',
      '.zip': 'application/zip'
    };
  
    const folders = {
      image: ['.jpg', '.jpeg', '.png'],
      audio: ['.mp3', '.ogg'],
      video: ['.mp4'],
      document: ['.pdf', '.doc', '.docx', '.xlsx'],
      kmz: ['.kmz', '.kml']
    };
  
    let subfolder = 'Outros';
    if (folders.image.includes(ext)) subfolder = 'Imagens';
    else if (folders.audio.includes(ext)) subfolder = 'Audios';
    else if (folders.video.includes(ext)) subfolder = 'Videos';
    else if (folders.document.includes(ext)) subfolder = 'Documentos';
    else if (folders.kmz.includes(ext)) subfolder = 'KMZ';
  
    const contentType = contentTypes[ext] || 'application/octet-stream';
  
    const uploadPath = `WhatsAppImages/${groupName}/${subfolder}/${fileName}`;
    const uploadUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/${uploadPath}:/content`;
  
    try {
      await axios.put(uploadUrl, buffer, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': contentType
        }
      });
  
      console.log(`☁️ Upload concluído: ${uploadPath}`);
    } catch (e) {
      console.error(`❌ Erro ao enviar para o OneDrive (${uploadPath}):`, e.message);
    }
  }

function wasFileModified(filePath) {
  return new Promise((resolve) => {
    fs.stat(filePath, (err, stats) => {
      if (err) return resolve(false);
      const mtime = stats.mtimeMs;

      db.get('SELECT last_modified FROM upload_logs WHERE file_path = ?', [filePath], (err, row) => {
        if (err || !row) return resolve(true);
        resolve(mtime > row.last_modified);
      });
    });
  });
};

function updateUploadLog(filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err) return;
    const mtime = stats.mtimeMs;
    const now = Date.now();

    db.run(`
      INSERT INTO upload_logs (file_path, last_uploaded, last_modified)
      VALUES (?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        last_uploaded = excluded.last_uploaded,
        last_modified = excluded.last_modified
    `, [filePath, now, mtime]);
  });
}



startOAuthServer();
