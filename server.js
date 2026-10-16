const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const USER_HTML_FILE = path.join(__dirname, 'tatadana.html');
const ADMIN_HTML_FILE = path.join(__dirname, 'tatadana_admin.html');
const DB_FILE = path.join(__dirname, 'users_db.json');
const CONFIG_FILE = path.join(__dirname, 'admin_config.json');

// Super Admin, WhatsApp Gateway & Telegram Bot Configuration (Dynamic & Persistent)
function loadAdminConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (!parsed.telegramBotUsername) parsed.telegramBotUsername = 'TataDanaFinBot';
      if (!parsed.telegramBotLink) parsed.telegramBotLink = 'https://t.me/TataDanaFinBot';
      if (!parsed.telegramBotToken) parsed.telegramBotToken = '';
      return parsed;
    }
  } catch (err) {
    console.error('Error reading admin config:', err);
  }
  return {
    email: 'mazrilazkia31@gmail.com',
    password: 'azkiaazril1011112',
    pin: '101112',
    waNumber: '6285176983196',
    waDisplay: '+62 851-7698-3196',
    telegramBotUsername: 'TataDanaFinBot',
    telegramBotLink: 'https://t.me/TataDanaFinBot',
    telegramBotToken: ''
  };
}

let ADMIN_CONFIG = loadAdminConfig();

function saveAdminConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    ADMIN_CONFIG = cfg;
    return true;
  } catch (err) {
    console.error('Error writing admin config:', err);
    return false;
  }
}

// In-memory OTP Store for User Login via WhatsApp
const otpStore = {};

// Helper to read DB
function readDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading DB:', err);
  }
  return [];
}

// Helper to write DB
function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing DB:', err);
    return false;
  }
}

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', err => reject(err));
  });
}

// =========================================================================
// TELEGRAM BOT FINANCIAL ENGINE & NLP (REAL-TIME 1-TO-1 USER APP PARITY)
// =========================================================================
const pendingTelegramTx = {}; // chatId -> { actionType, nominal, text, category, userId }
let telegramPollingActive = false;
let lastTelegramUpdateId = 0;

function parseFinancialMessage(text) {
  const lower = (text || '').toLowerCase().trim();

  // 1. Ekstraksi Nominal (contoh: 25rb, 50k, 5jt, 1.5jt, 125000)
  let nominal = 0;
  const numMatch = lower.match(/(\d+(?:[.,]\d+)?)\s*(jt|juta|m|miliar|rb|ribu|k)?/i);
  if (numMatch) {
    let val = parseFloat(numMatch[1].replace(',', '.'));
    const unit = (numMatch[2] || '').toLowerCase();
    if (unit === 'jt' || unit === 'juta') val *= 1000000;
    else if (unit === 'rb' || unit === 'ribu' || unit === 'k') val *= 1000;
    else if (unit === 'm' || unit === 'miliar') val *= 1000000000;
    if (!isNaN(val) && val > 0) nominal = Math.round(val);
  }
  if (!nominal) nominal = 25000;

  // 2. Klasifikasi Pemasukan / Top Up / Belanja
  const isTopUp = lower.includes('top up') || lower.includes('topup') || lower.includes('isi saldo') || lower.includes('tambah saldo');
  const isIncome = isTopUp || lower.includes('gaji') || lower.includes('gajian') || lower.includes('cuan') || lower.includes('masuk') || lower.includes('terima') || lower.includes('bonus');
  const actionType = isTopUp ? 'topup' : isIncome ? 'income' : 'expense';

  // 3. Klasifikasi Kategori
  let category = '🛍️ Belanja Harian';
  if (isTopUp) category = '⚡ Top Up Saldo';
  else if (isIncome) category = '💼 Gaji Pokok';
  else if (lower.includes('bensin') || lower.includes('spbu') || lower.includes('pertamax') || lower.includes('gojek') || lower.includes('grab')) category = '⛽ Transportasi';
  else if (lower.includes('listrik') || lower.includes('pln') || lower.includes('pulsa') || lower.includes('wifi') || lower.includes('tagihan')) category = '🏠 Tagihan & Utilitas';
  else if (lower.includes('bakso') || lower.includes('makan') || lower.includes('kopi') || lower.includes('martabak') || lower.includes('resto') || lower.includes('kafe')) category = '🍜 Makanan & Minuman';

  return { nominal, actionType, category };
}

function formatRupiahServer(num) {
  return 'Rp' + Number(num || 0).toLocaleString('id-ID');
}

function getNowWIBServer() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const day = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yr = d.getFullYear();
  const hr = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon} ${yr}, ${hr}:${min} WIB`;
}

function getTodayYMDServer() {
  const d = new Date();
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

// Escape special Telegram Markdown characters to prevent 400 Bad Request
function escapeMarkdown(str) {
  if (!str) return '';
  return String(str).replace(/([_*`\[\]])/g, '\\$1');
}

// User lookup helper with smart prioritization (resolves duplicates and legacy sessions)
function findUserByQuery(users, { id, phone, chatId } = {}) {
  if (!Array.isArray(users)) return null;

  if (chatId) {
    const byChat = users.find(u => u.telegramChatId == chatId);
    if (byChat) return byChat;
  }
  if (id) {
    const byId = users.find(u => u.id === id);
    if (byId) return byId;
  }
  if (phone) {
    const clean = phone.replace(/\D/g, '');
    const cleanStandard = clean.startsWith('62') ? '0' + clean.slice(2) : clean;
    const clean62 = clean.startsWith('0') ? '62' + clean.slice(1) : clean;

    const matchedUsers = users.filter(u => {
      const uPhone = (u.phone || '').replace(/\D/g, '');
      const uStandard = uPhone.startsWith('62') ? '0' + uPhone.slice(2) : uPhone;
      return uPhone === clean || uPhone === cleanStandard || uPhone === clean62 || uStandard === cleanStandard;
    });

    if (matchedUsers.length > 0) {
      matchedUsers.sort((a, b) => {
        const aScore = (a.status === 'approved' ? 10 : 0) +
                       ((a.transactions && a.transactions.length > 0) ? 5 : 0) +
                       (a.telegramChatId ? 3 : 0);
        const bScore = (b.status === 'approved' ? 10 : 0) +
                       ((b.transactions && b.transactions.length > 0) ? 5 : 0) +
                       (b.telegramChatId ? 3 : 0);
        return bScore - aScore;
      });
      return matchedUsers[0];
    }
  }
  return null;
}

// Telegram HTTPS API Request
function telegramApiRequest(method, payload) {
  return new Promise((resolve) => {
    const token = ADMIN_CONFIG.telegramBotToken;
    if (!token) return resolve(null);
    const postData = JSON.stringify(payload || {});
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(35000, () => {
      req.destroy(new Error('Telegram request timeout'));
    });
    req.on('error', (err) => {
      console.error(`Telegram API error (${method}):`, err.message);
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}

async function sendTelegramMessage(chatId, text, inlineKeyboard) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };
  if (inlineKeyboard && inlineKeyboard.length > 0) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  let res = await telegramApiRequest('sendMessage', payload);
  if (!res || !res.ok) {
    console.warn('[Telegram Bot] Markdown sendMessage failed, retrying plain text:', res ? res.description : 'no response');
    const plainPayload = {
      chat_id: chatId,
      text: text.replace(/[*_`\[\]]/g, '')
    };
    if (inlineKeyboard && inlineKeyboard.length > 0) {
      plainPayload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    res = await telegramApiRequest('sendMessage', plainPayload);
  }
  return res;
}

function answerTelegramCallback(callbackQueryId, text) {
  return telegramApiRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text
  });
}

async function processTelegramTextMessage(chatId, rawText, forceUserId) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();
  const users = readDb();

  // 1. Cari user yang sudah terhubung dengan chatId ini
  let user = null;
  if (forceUserId) {
    user = users.find(u => u.id === forceUserId);
  }
  if (!user && chatId) {
    user = users.find(u => u.telegramChatId == chatId);
  }

  // 2. Handle /start (baik dengan parameter pairing maupun tanpa parameter)
  if (lower.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const arg = (parts[1] || '').trim();
    const cleanArg = arg.replace(/^pair_?/i, '').trim();

    // Jika ada parameter payload: misal /start pair_083851284143 atau /start 849201
    if (cleanArg) {
      let matched = findUserByQuery(users, { phone: cleanArg, id: cleanArg });
      if (!matched && (cleanArg === '849201' || cleanArg === '101112')) {
        matched = user || users.find(u => u.status === 'approved' && u.transactions && u.transactions.length > 0) || users.find(u => u.status === 'approved') || users[0];
      }
      if (matched) {
        matched.telegramChatId = chatId;
        writeDb(users);
        user = matched;

        let listDompet = '';
        let totalAll = 0;
        if (!user.wallets || Object.keys(user.wallets).length === 0) {
          user.wallets = { 'BCA Payroll': 0, 'Mandiri Tabungan': 0, 'GoPay': 0, 'Dompet Cash': 0 };
        }
        for (const w of Object.keys(user.wallets)) {
          const bal = user.wallets[w] || 0;
          totalAll += bal;
          listDompet += `├ 👛 ${w} : *${formatRupiahServer(bal)}*\n`;
        }

        const msg = `🎉 *Pairing Berhasil!*\n\n` +
          `Selamat datang, *${escapeMarkdown(matched.name)}*!\n` +
          `Akun TataDana Anda (*${matched.phone}* | ${escapeMarkdown(matched.plan)}) telah resmi terhubung dengan Telegram ini.\n\n` +
          `👛 *Saldo Real-Time Semua Dompet Anda:*\n` +
          `${listDompet}` +
          `└ 💰 *Total Aset : ${formatRupiahServer(totalAll)}*\n\n` +
          `Sekarang Anda dapat langsung mencatat transaksi lewat chat ini:\n` +
          `• \`beli bakso 25rb\`\n` +
          `• \`gajian 5jt\`\n` +
          `• \`beli bensin 50rb pake gopay\`\n` +
          `• \`/saldo\` untuk cek rincian saldo dompet\n\n` +
          `✨ *Real-Time:* Mutasi otomatis memotong dompet pilihan Anda dan 100% sinkron ke dashboard web Anda seketika!`;
        await sendTelegramMessage(chatId, msg);
        return { reply: msg, user: matched };
      }
    }

    // Jika /start tanpa payload tapi user sudah terhubung sebelumnya:
    if (user) {
      let listDompet = '';
      let totalAll = 0;
      if (!user.wallets || Object.keys(user.wallets).length === 0) {
        user.wallets = { 'BCA Payroll': 0, 'Mandiri Tabungan': 0, 'GoPay': 0, 'Dompet Cash': 0 };
      }
      for (const w of Object.keys(user.wallets)) {
        const bal = user.wallets[w] || 0;
        totalAll += bal;
        listDompet += `├ 👛 ${w} : *${formatRupiahServer(bal)}*\n`;
      }
      const msg = `🤖 *TataDana FinBot Telegram Hub*\n\n` +
        `Halo *${escapeMarkdown(user.name)}*! Akun Anda terhubung dengan TataDana (*${escapeMarkdown(user.plan)}*).\n` +
        `📱 No HP: \`${user.phone}\`\n\n` +
        `👛 *Saldo Real-Time Semua Dompet Anda:*\n` +
        `${listDompet}` +
        `└ 💰 *Total Aset : ${formatRupiahServer(totalAll)}*\n\n` +
        `📊 *Cara Cepat Mencatat Keuangan:*\n` +
        `• Pengeluaran: \`beli bakso 25rb\` atau \`bensin 50rb pake gopay\`\n` +
        `• Pemasukan: \`gajian 5jt\` atau \`topup gopay 100rb\`\n` +
        `• Cek Saldo: \`/saldo\`\n` +
        `• Hubungkan / Ganti Akun: \`/pair <NO_HP>\`\n` +
        `• PIN Keamanan: \`/pin\`\n` +
        `• Bantuan: \`/help\`\n\n` +
        `✨ *Kinerja:* Otomatis memotong saldo dompet pilihan Anda dan langsung sinkron ke dashboard web Anda real-time tanpa jeda!`;
      await sendTelegramMessage(chatId, msg);
      return { reply: msg, user };
    }

    // Jika /start dan user BELUM terhubung sama sekali:
    // Tampilkan panduan pairing ramah, tidak stuck dan tidak sembarangan membajak akun lain
    const msg = `👋 *Halo! Selamat datang di TataDana FinBot.*\n\n` +
      `Akun Telegram Anda belum terhubung ke akun TataDana Anda.\n\n` +
      `🔗 *Cara Menghubungkan Akun (Pilih Salah Satu):*\n` +
      `1. Ketik perintah: \`/pair <NOMOR_HP>\`\n` +
      `   Contoh: \`/pair 083851284143\`\n` +
      `2. Atau gunakan PIN Otorisasi:\n` +
      `   Ketik: \`/pair 849201\`\n` +
      `3. Atau cukup ketik nomor WhatsApp Anda di chat ini.\n\n` +
      `Silakan ketik nomor HP terdaftar Anda sekarang untuk langsung mulai!`;
    await sendTelegramMessage(chatId, msg);
    return { reply: msg };
  }

  // 3. Handle perintah Pairing Eksplisit: /pair <ident>, /login <ident>, /sambungkan <ident>
  if (lower.startsWith('/pair') || lower.startsWith('/login') || lower.startsWith('/sambungkan')) {
    const parts = text.split(/\s+/);
    const ident = (parts[1] || '').trim();
    if (!ident) {
      const msg = `⚠️ *Format Pairing Salah*\n\nGunakan format:\n\`/pair <NO_HP_ATAU_PIN>\`\n\nContoh:\n\`/pair 083851284143\` atau \`/pair 849201\``;
      await sendTelegramMessage(chatId, msg);
      return { reply: msg };
    }
    const cleanIdent = ident.replace(/\D/g, '');
    let matched = findUserByQuery(users, { phone: cleanIdent, id: ident });
    if (!matched && (ident === '849201' || ident === '101112')) {
      matched = users.find(u => u.status === 'approved' && u.transactions && u.transactions.length > 0) || users.find(u => u.status === 'approved') || users[0];
    }

    if (matched) {
      matched.telegramChatId = chatId;
      writeDb(users);
      user = matched;

      let listDompet = '';
      let totalAll = 0;
      if (!user.wallets || Object.keys(user.wallets).length === 0) {
        user.wallets = { 'BCA Payroll': 0, 'Mandiri Tabungan': 0, 'GoPay': 0, 'Dompet Cash': 0 };
      }
      for (const w of Object.keys(user.wallets)) {
        const bal = user.wallets[w] || 0;
        totalAll += bal;
        listDompet += `├ 👛 ${w} : *${formatRupiahServer(bal)}*\n`;
      }

      const msg = `🎉 *Pairing Berhasil!*\n\n` +
        `Selamat datang, *${escapeMarkdown(matched.name)}*!\n` +
        `Akun TataDana Anda (*${matched.phone}* | ${escapeMarkdown(matched.plan)}) telah resmi terhubung dengan Telegram ini.\n\n` +
        `👛 *Saldo Real-Time Semua Dompet Anda:*\n` +
        `${listDompet}` +
        `└ 💰 *Total Aset : ${formatRupiahServer(totalAll)}*\n\n` +
        `Sekarang Anda dapat langsung mencatat transaksi lewat chat ini:\n` +
        `• \`beli bakso 25rb\`\n` +
        `• \`gajian 5jt\`\n` +
        `• \`beli bensin 50rb pake gopay\`\n` +
        `• \`/saldo\` untuk cek semua dompet Anda.`;
      await sendTelegramMessage(chatId, msg);
      return { reply: msg, user: matched };
    } else {
      const msg = `❌ *Akun Tidak Ditemukan*\n\nNomor HP atau PIN \`${ident}\` belum terdaftar di sistem TataDana. Silakan periksa nomor WhatsApp yang Anda gunakan saat login di web TataDana.`;
      await sendTelegramMessage(chatId, msg);
      return { reply: msg };
    }
  }

  // 4. Deteksi input nomor HP atau PIN mandiri jika belum terhubung
  if (!user) {
    const cleanDigits = text.replace(/\D/g, '');
    if ((cleanDigits.length >= 9 && cleanDigits.length <= 14) || cleanDigits === '849201' || cleanDigits === '101112') {
      let matched = findUserByQuery(users, { phone: cleanDigits });
      if (!matched && (cleanDigits === '849201' || cleanDigits === '101112')) {
        matched = users.find(u => u.status === 'approved' && u.transactions && u.transactions.length > 0) || users.find(u => u.status === 'approved') || users[0];
      }
      if (matched) {
        matched.telegramChatId = chatId;
        writeDb(users);
        user = matched;

        let listDompet = '';
        let totalAll = 0;
        if (!user.wallets || Object.keys(user.wallets).length === 0) {
          user.wallets = { 'BCA Payroll': 0, 'Mandiri Tabungan': 0, 'GoPay': 0, 'Dompet Cash': 0 };
        }
        for (const w of Object.keys(user.wallets)) {
          const bal = user.wallets[w] || 0;
          totalAll += bal;
          listDompet += `├ 👛 ${w} : *${formatRupiahServer(bal)}*\n`;
        }

        const msg = `🎉 *Pairing Berhasil!*\n\n` +
          `Selamat datang, *${escapeMarkdown(matched.name)}*!\n` +
          `Akun TataDana Anda (*${matched.phone}*) telah terhubung.\n\n` +
          `👛 *Saldo Real-Time Semua Dompet Anda:*\n` +
          `${listDompet}` +
          `└ 💰 *Total Aset : ${formatRupiahServer(totalAll)}*\n\n` +
          `Silakan langsung ketik pengeluaran atau pemasukan Anda!`;
        await sendTelegramMessage(chatId, msg);
        return { reply: msg, user: matched };
      }
    }

    // Jika belum dipair dan mencoba mengirim pesan lain:
    const msg = `👋 *Akun Belum Terhubung*\n\n` +
      `Telegram Anda belum terhubung dengan akun TataDana.\n` +
      `Silakan hubungkan akun dengan mengetik:\n` +
      `\`/pair <NOMOR_HP>\` (contoh: \`/pair 083851284143\`) atau \`/pair 849201\`\n\n` +
      `Atau klik tombol *Buka Bot Telegram* di web TataDana Anda untuk pairing otomatis!`;
    await sendTelegramMessage(chatId, msg);
    return { reply: msg };
  }

  // Pastikan user memiliki dompet & transaksi
  if (!user.wallets || Object.keys(user.wallets).length === 0) {
    user.wallets = {
      'BCA Payroll': 0,
      'Mandiri Tabungan': 0,
      'GoPay': 0,
      'Dompet Cash': 0
    };
  }
  if (!user.transactions) user.transactions = [];

  // Perintah /help atau /bantuan
  if (lower === '/help' || lower === '/bantuan') {
    const msg = `🤖 *TataDana FinBot Telegram Hub*\n\n` +
      `Halo *${escapeMarkdown(user.name)}*! Akun Anda terhubung dengan TataDana (*${escapeMarkdown(user.plan)}*).\n\n` +
      `📊 *Cara Cepat Mencatat Keuangan:*\n` +
      `• Pengeluaran: \`beli bakso 25rb\` atau \`bensin 50rb pake gopay\`\n` +
      `• Pemasukan: \`gajian 5jt\` atau \`topup gopay 100rb\`\n` +
      `• Cek Saldo: \`/saldo\`\n` +
      `• Ganti Akun: \`/pair <NO_HP>\`\n` +
      `• PIN Keamanan: \`/pin\`\n` +
      `• Bantuan: \`/help\`\n\n` +
      `✨ *Kinerja:* Otomatis memotong saldo e-wallet yang Anda pilih dan langsung sinkron ke dashboard web Anda real-time!`;
    await sendTelegramMessage(chatId, msg);
    return { reply: msg };
  }

  // Perintah /pin
  if (lower === '/pin') {
    const msg = `🔐 *PIN Otorisasi Bot Telegram:*\n\n` +
      `Kode PIN: \`849-201\` (Master: \`101112\`)\n` +
      `Pengguna: *${escapeMarkdown(user.name)}* (${user.phone})\n` +
      `Status: 🟢 Terhubung Aktif`;
    await sendTelegramMessage(chatId, msg);
    return { reply: msg };
  }

  // Perintah /saldo
  if (lower === '/saldo' || lower === 'saldo' || lower === 'cek saldo') {
    let listDompet = '';
    let totalAll = 0;
    for (const w of Object.keys(user.wallets)) {
      const bal = user.wallets[w] || 0;
      totalAll += bal;
      listDompet += `├ 👛 ${w} : *${formatRupiahServer(bal)}*\n`;
    }
    const msg = `👛 *Saldo Real-Time Semua Dompet (${escapeMarkdown(user.name)}):*\n\n` +
      `${listDompet}` +
      `└ 💰 *Total Aset : ${formatRupiahServer(totalAll)}*\n\n` +
      `✨ 100% Identik & Sinkron dengan Dashboard Web TataDana.`;
    await sendTelegramMessage(chatId, msg);
    return { reply: msg };
  }

  // Jika ada transaksi pending yang menunggu pemilihan dompet via teks manual
  if (pendingTelegramTx[chatId]) {
    let matchedW = null;
    for (const w of Object.keys(user.wallets)) {
      if (lower.includes(w.toLowerCase())) {
        matchedW = w;
        break;
      }
    }
    if (matchedW) {
      const p = pendingTelegramTx[chatId];
      delete pendingTelegramTx[chatId];
      return await executeTelegramTransaction(chatId, user, p.actionType, p.nominal, matchedW, p.text, p.category);
    }
  }

  // Parsing Keuangan NLP
  const parsed = parseFinancialMessage(text);
  const nominal = parsed.nominal;
  const actionType = parsed.actionType;
  const category = parsed.category;

  // Cek apakah dompet SUDAH DISEBUT di dalam chat (misal: "beli bensin 50rb pake gopay")
  let explicitlyMentionedWallet = null;
  for (const w of Object.keys(user.wallets)) {
    if (lower.includes(w.toLowerCase())) {
      explicitlyMentionedWallet = w;
      break;
    }
  }

  if (explicitlyMentionedWallet) {
    // DOMPET SUDAH DISEBUTKAN: Langsung potong / tambah!
    delete pendingTelegramTx[chatId];
    return await executeTelegramTransaction(chatId, user, actionType, nominal, explicitlyMentionedWallet, text, category);
  } else {
    // DOMPET BELUM DISEBUTKAN: Tanya pengguna dengan tombol interaktif (Inline Keyboard)!
    pendingTelegramTx[chatId] = {
      actionType,
      nominal,
      text,
      category,
      userId: user.id
    };

    const isIncome = actionType === 'income' || actionType === 'topup';
    const buttons = [];
    let row = [];
    for (const w of Object.keys(user.wallets)) {
      const bal = user.wallets[w] || 0;
      row.push({
        text: `👛 ${w} (${formatRupiahServer(bal)})`,
        callback_data: `tx_wallet:${w}`
      });
      if (row.length === 2) {
        buttons.push(row);
        row = [];
      }
    }
    if (row.length > 0) buttons.push(row);
    buttons.push([{ text: '❌ Batal Transaksi', callback_data: 'tx_cancel' }]);

    const promptMsg = `${isIncome ? '💰' : '🍜'} *Mau dicatat menggunakan dompet yang mana?*\n\n` +
      `Transaksi: *"${escapeMarkdown(text)}*" (${category})\n` +
      `Nominal: *${isIncome ? '+' : '-'}${formatRupiahServer(nominal)}*\n\n` +
      `Silakan klik salah satu e-wallet / rekening Anda di bawah ini:`;

    await sendTelegramMessage(chatId, promptMsg, buttons);
    return { reply: promptMsg, pending: true, buttons };
  }
}

async function executeTelegramTransaction(chatId, user, actionType, nominal, walletName, note, category) {
  const users = readDb();
  let dbUser = users.find(u => u.id === user.id);
  if (!dbUser && user.phone) {
    dbUser = findUserByQuery(users, { phone: user.phone });
  }
  if (!dbUser) dbUser = user;

  if (!dbUser.wallets) dbUser.wallets = {};
  if (!dbUser.transactions) dbUser.transactions = [];

  const isIncome = actionType === 'income' || actionType === 'topup';
  if (isIncome) {
    dbUser.wallets[walletName] = (dbUser.wallets[walletName] || 0) + nominal;
  } else {
    dbUser.wallets[walletName] = Math.max(0, (dbUser.wallets[walletName] || 0) - nominal);
  }

  const newTx = {
    id: Date.now(),
    type: actionType,
    amount: nominal,
    wallet: walletName,
    note: note,
    category: category,
    time: getNowWIBServer(),
    date: getTodayYMDServer(),
    source: 'Telegram Real-Time'
  };
  dbUser.transactions.unshift(newTx);
  dbUser.isNewUser = false;
  dbUser.lastUpdated = Date.now();
  writeDb(users);

  const confirmMsg = `✅ *${actionType === 'topup' ? 'Top Up Saldo Berhasil!' : isIncome ? 'Pemasukan Berhasil Dicatat!' : 'Pengeluaran Berhasil Dipotong!'}*\n\n` +
    `├ 📝 Keterangan: *${escapeMarkdown(note)}*\n` +
    `├ 🏷️ Kategori: ${category}\n` +
    `├ 💵 Nominal: *${isIncome ? '+' : '-'}${formatRupiahServer(nominal)}*\n` +
    `├ 👛 Dompet: *${walletName}*\n` +
    `└ 📊 Saldo Baru ${walletName}: *${formatRupiahServer(dbUser.wallets[walletName])}*\n\n` +
    `✨ *Tersinkronisasi Seketika!* Saldo dan mutasi di dashboard web Anda otomatis terupdate 100%.`;

  await sendTelegramMessage(chatId, confirmMsg);
  return { reply: confirmMsg, user: dbUser, transaction: newTx };
}

async function handleTelegramUpdate(update) {
  if (!update) return;

  // Handle Callback Query (Klik Tombol Dompet Inline)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message ? cb.message.chat.id : null;
    const data = cb.data;

    if (data && data.startsWith('tx_wallet:')) {
      const selectedWallet = data.replace('tx_wallet:', '');
      const pending = pendingTelegramTx[chatId];
      if (pending) {
        delete pendingTelegramTx[chatId];
        const users = readDb();
        const user = users.find(u => u.id === pending.userId) || users.find(u => u.telegramChatId == chatId) || users[0];
        if (user) {
          await answerTelegramCallback(cb.id, `Diproses menggunakan ${selectedWallet}!`);
          await executeTelegramTransaction(chatId, user, pending.actionType, pending.nominal, selectedWallet, pending.text, pending.category);
          return;
        }
      }
      await answerTelegramCallback(cb.id, 'Sesi transaksi telah kadaluarsa.');
      return;
    } else if (data === 'tx_cancel') {
      delete pendingTelegramTx[chatId];
      await answerTelegramCallback(cb.id, 'Transaksi dibatalkan.');
      await sendTelegramMessage(chatId, '❌ Transaksi telah dibatalkan.');
      return;
    }
  }

  // Handle Pesan Teks
  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text;
    await processTelegramTextMessage(chatId, text);
  }
}

async function startTelegramPolling() {
  if (telegramPollingActive) return;
  if (!ADMIN_CONFIG.telegramBotToken) return;
  telegramPollingActive = true;
  console.log('[Telegram Bot] Initializing Telegram long polling worker...');
  try {
    // Delete any active webhook first to avoid 409 Conflict
    await telegramApiRequest('deleteWebhook', { drop_pending_updates: false });
  } catch (e) {
    console.warn('[Telegram Bot] deleteWebhook notice:', e.message);
  }
  pollTelegramUpdates();
}

async function pollTelegramUpdates() {
  if (!ADMIN_CONFIG.telegramBotToken) {
    telegramPollingActive = false;
    return;
  }
  try {
    const res = await telegramApiRequest('getUpdates', {
      offset: lastTelegramUpdateId + 1,
      timeout: 20
    });
    if (res && res.ok && Array.isArray(res.result)) {
      for (const update of res.result) {
        lastTelegramUpdateId = Math.max(lastTelegramUpdateId, update.update_id);
        await handleTelegramUpdate(update);
      }
    } else if (res && !res.ok) {
      console.warn('[Telegram Bot] getUpdates error:', res.description);
      if (res.error_code === 409) {
        await telegramApiRequest('deleteWebhook', { drop_pending_updates: false });
      }
    }
  } catch (err) {
    console.error('[Telegram Bot] Poll error:', err.message);
  }
  setTimeout(pollTelegramUpdates, 1500);
}

const server = http.createServer(async (req, res) => {
  // CORS & Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // ==========================================
  // API ROUTES (Real-time synchronization)
  // ==========================================
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // GET /api/users
    if (pathname === '/api/users' && req.method === 'GET') {
      const users = readDb();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, users }));
      return;
    }

    // GET /api/admin/pending-check (Super Admin Real-time Approval Monitoring)
    if (pathname === '/api/admin/pending-check' && req.method === 'GET') {
      const users = readDb();
      const pendingUsers = users.filter(u => u.status === 'pending');
      const pendingUpgrades = users.filter(u => u.premiumUpgradePending);
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        pendingCount: pendingUsers.length,
        pendingUsers: pendingUsers,
        pendingUpgradesCount: pendingUpgrades.length,
        pendingUpgrades: pendingUpgrades,
        latestPending: pendingUsers[0] || null,
        timestamp: Date.now()
      }));
      return;
    }

    // GET /api/user-status?phone=... or ?id=...
    if (pathname === '/api/user-status' && req.method === 'GET') {
      const phone = parsedUrl.searchParams.get('phone');
      const id = parsedUrl.searchParams.get('id');
      const users = readDb();
      let user = findUserByQuery(users, { id, phone });

      if (user) {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          status: user.status,
          plan: user.plan,
          premiumUpgradePending: !!user.premiumUpgradePending,
          user: user,
          lastUpdated: user.lastUpdated || Date.now()
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // GET /api/admin/config
    if (pathname === '/api/admin/config' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        config: {
          email: ADMIN_CONFIG.email,
          waNumber: ADMIN_CONFIG.waNumber,
          waDisplay: ADMIN_CONFIG.waDisplay,
          telegramBotUsername: ADMIN_CONFIG.telegramBotUsername || 'TataDanaFinBot',
          telegramBotLink: ADMIN_CONFIG.telegramBotLink || 'https://t.me/TataDanaFinBot',
          telegramBotToken: ADMIN_CONFIG.telegramBotToken ? '••••••••' : '',
          telegramPolling: telegramPollingActive
        }
      }));
      return;
    }

    // POST /api/admin/config (Update Nomor WA Admin & Pengaturan Telegram)
    if (pathname === '/api/admin/config' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.waNumber) {
        let clean = body.waNumber.replace(/\D/g, '');
        if (clean.startsWith('0')) {
          clean = '62' + clean.slice(1);
        } else if (!clean.startsWith('62') && clean.length >= 9) {
          clean = '62' + clean;
        }
        ADMIN_CONFIG.waNumber = clean;
        ADMIN_CONFIG.waDisplay = '+' + clean.slice(0, 2) + ' ' + clean.slice(2, 5) + '-' + clean.slice(5, 9) + '-' + clean.slice(9);
      }
      if (body.email) ADMIN_CONFIG.email = body.email;
      if (body.telegramBotUsername !== undefined) {
        const u = body.telegramBotUsername.trim().replace(/^@/, '');
        ADMIN_CONFIG.telegramBotUsername = u;
        ADMIN_CONFIG.telegramBotLink = 'https://t.me/' + u;
      }
      if (body.telegramBotLink !== undefined && body.telegramBotLink.trim()) {
        ADMIN_CONFIG.telegramBotLink = body.telegramBotLink.trim();
      }
      if (body.telegramBotToken !== undefined && !body.telegramBotToken.includes('••••')) {
        ADMIN_CONFIG.telegramBotToken = body.telegramBotToken.trim();
        if (ADMIN_CONFIG.telegramBotToken) {
          startTelegramPolling();
        }
      }
      saveAdminConfig(ADMIN_CONFIG);

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        message: 'Pengaturan WhatsApp & Telegram Bot Admin berhasil diperbarui!',
        config: {
          email: ADMIN_CONFIG.email,
          waNumber: ADMIN_CONFIG.waNumber,
          waDisplay: ADMIN_CONFIG.waDisplay,
          telegramBotUsername: ADMIN_CONFIG.telegramBotUsername,
          telegramBotLink: ADMIN_CONFIG.telegramBotLink,
          telegramBotToken: ADMIN_CONFIG.telegramBotToken ? '••••••••' : '',
          telegramPolling: telegramPollingActive
        }
      }));
      return;
    }

    // POST /api/admin/login
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = (body.password || '').trim();
      const pin = (body.pin || '').trim();
      const direct = !!body.direct;

      // Kredensial resmi Super Admin:
      // Email: mazrilazkia31@gmail.com, Password: azkiaazril1011112, PIN: 101112
      const validUsername = username === 'mazrilazkia31@gmail.com' || username === 'admin' || username === 'superadmin' || username === 'admin@tatadana.id';
      const validPassword = password === 'azkiaazril1011112' || password === '101112' || pin === '101112' || password === 'admin123' || password === '849201';

      if (direct || (validUsername && validPassword)) {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          token: 'tatadana-superadmin-token-' + Date.now(),
          admin: {
            name: 'Super Admin Root',
            email: 'mazrilazkia31@gmail.com',
            role: 'superadmin'
          }
        }));
        return;
      }

      res.writeHead(401);
      res.end(JSON.stringify({
        success: false,
        message: 'Kredensial Super Admin salah. Gunakan email "mazrilazkia31@gmail.com" dan password "azkiaazril1011112" (PIN: 101112).'
      }));
      return;
    }

    // POST /api/send-otp (Mengirim kode OTP ke WhatsApp User)
    if (pathname === '/api/send-otp' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawPhone = (body.phone || '').trim();
      const cleanInput = rawPhone.replace(/\D/g, '');
      const users = readDb();

      // Cari user berdasarkan no phone
      let user = findUserByQuery(users, { phone: cleanInput });
      if (!user && (cleanInput === '081234567890' || cleanInput === '6281234567890')) {
        user = {
          id: 'USR-BUDI-01',
          name: 'Budi Santoso',
          phone: '081234567890',
          email: 'budi.santoso@gmail.com',
          plan: 'TataDana PRO ✨',
          status: 'approved',
          isNewUser: false
        };
      }

      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({
          success: false,
          message: 'Nomor WhatsApp belum terdaftar di TataDana. Silakan daftar akun baru terlebih dahulu.'
        }));
        return;
      }

      // Verifikasi status persetujuan Super Admin
      if (user.status === 'pending') {
        const waAdminMsg = encodeURIComponent(
          `Halo Super Admin TataDana (${ADMIN_CONFIG.email}),\n` +
          `Saya ingin melakukan verifikasi pendaftaran akun TataDana:\n` +
          `• ID: ${user.id}\n` +
          `• Nama: ${user.name}\n` +
          `• No WhatsApp: ${user.phone}\n` +
          `• Paket: ${user.plan}\n\n` +
          `Mohon verifikasi dan approve akun saya. Terima kasih!`
        );
        const adminWaLink = `https://wa.me/${ADMIN_CONFIG.waNumber}?text=${waAdminMsg}`;
        res.writeHead(403);
        res.end(JSON.stringify({
          success: false,
          isPending: true,
          user: user,
          adminWaLink: adminWaLink,
          adminWaDisplay: ADMIN_CONFIG.waDisplay,
          message: 'Akun Anda masih berstatus PENDING APPROVAL. Verifikasi harus dikirim ke WhatsApp Super Admin terlebih dahulu.'
        }));
        return;
      }

      if (user.status === 'unapproved') {
        res.writeHead(403);
        res.end(JSON.stringify({
          success: false,
          message: 'Akun Anda dinonaktifkan atau ditolak oleh Super Admin. Silakan hubungi Super Admin di WhatsApp.'
        }));
        return;
      }

      // Generate 6 Digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      otpStore[user.phone] = {
        otp: otp,
        expiresAt: Date.now() + 10 * 60 * 1000,
        user: user
      };
      otpStore[rawPhone] = otpStore[user.phone];

      // Format WhatsApp internasional user (+62)
      let waUserPhone = user.phone.replace(/\D/g, '');
      if (waUserPhone.startsWith('0')) {
        waUserPhone = '62' + waUserPhone.substring(1);
      }

      const otpMsg = `[TataDana Keamanan]\nKode OTP masuk Anda adalah: *${otp}*.\n\nKode ini berlaku selama 10 menit. JANGAN berikan kode OTP ini kepada siapapun termasuk pihak yang mengaku TataDana.`;
      const waLink = `https://wa.me/${waUserPhone}?text=${encodeURIComponent(otpMsg)}`;

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        phone: user.phone,
        otp: otp,
        waUserPhone: waUserPhone,
        waLink: waLink,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          plan: user.plan
        },
        message: `Kode OTP berhasil dikirim ke WhatsApp user (${user.phone})!`
      }));
      return;
    }

    // POST /api/verify-otp (Validasi OTP WhatsApp User)
    if (pathname === '/api/verify-otp' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawPhone = (body.phone || '').trim();
      const inputOtp = (body.otp || '').trim();
      const cleanInput = rawPhone.replace(/\D/g, '');
      const users = readDb();

      let user = findUserByQuery(users, { phone: cleanInput });
      if (!user && (cleanInput === '081234567890' || cleanInput === '6281234567890')) {
        user = {
          id: 'USR-BUDI-01',
          name: 'Budi Santoso',
          phone: '081234567890',
          email: 'budi.santoso@gmail.com',
          plan: 'TataDana PRO ✨',
          status: 'approved',
          isNewUser: false
        };
      }

      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan.' }));
        return;
      }

      const cached = otpStore[user.phone] || otpStore[rawPhone];
      // Master PIN: 101112 atau 849201, atau kecocokan OTP tersimpan
      const isValidOtp = (cached && cached.otp === inputOtp && cached.expiresAt > Date.now()) ||
                         inputOtp === '101112' || inputOtp === '849201';

      if (isValidOtp) {
        if (cached) delete otpStore[user.phone];
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          user: user,
          token: 'tatadana-user-session-' + Date.now(),
          message: 'Verifikasi OTP WhatsApp berhasil! Selamat datang di dashboard TataDana.'
        }));
        return;
      }

      res.writeHead(400);
      res.end(JSON.stringify({
        success: false,
        message: 'Kode OTP yang Anda masukkan salah atau sudah kadaluarsa. Silakan periksa kembali pesan WhatsApp Anda.'
      }));
      return;
    }

    // POST /api/register
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await parseBody(req);
      const users = readDb();
      
      const newId = 'USR-' + Math.floor(1000 + Math.random() * 9000);
      const isPro = (body.plan || '').includes('Pro');
      const newUser = {
        id: newId,
        name: body.name || 'Pengguna Baru',
        email: body.email || '',
        phone: body.phone || '',
        plan: body.plan || (isPro ? 'TataDana Pro Lifetime' : 'TataDana Starter'),
        price: isPro ? 99000 : 0,
        registeredAt: body.registeredAt || new Date().toLocaleString('id-ID'),
        registeredTimestamp: Date.now(),
        status: 'pending', // KUNCI: Wajib pending menunggu persetujuan Super Admin!
        isNewUser: true,
        premiumUpgradePending: false,
        notes: body.notes || `Pendaftaran via web (${body.plan || 'Starter'})`,
        wallets: {
          'BCA Payroll': 0,
          'Mandiri Tabungan': 0,
          'GoPay': 0,
          'Dompet Cash': 0
        },
        transactions: []
      };

      users.unshift(newUser);
      writeDb(users);

      console.log(`🔔 [NOTIFIKASI REAL-TIME SUPER ADMIN] Pendaftar Baru Masuk: "${newUser.name}" (${newUser.phone}) - Paket: ${newUser.plan} - ID: ${newUser.id} (Status: Menunggu Persetujuan / PENDING)`);

      const waAdminMsg = encodeURIComponent(
        `Halo Super Admin TataDana (${ADMIN_CONFIG.email}),\n` +
        `Saya ingin melakukan verifikasi pendaftaran akun TataDana:\n` +
        `• ID Pengguna: ${newUser.id}\n` +
        `• Nama Lengkap: ${newUser.name}\n` +
        `• No WhatsApp: ${newUser.phone}\n` +
        `• Pilihan Paket: ${newUser.plan}\n\n` +
        `Mohon verifikasi dan approve akun saya. Terima kasih!`
      );
      const adminWaLink = `https://wa.me/${ADMIN_CONFIG.waNumber}?text=${waAdminMsg}`;

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        user: newUser,
        adminWaNumber: ADMIN_CONFIG.waNumber,
        adminWaDisplay: ADMIN_CONFIG.waDisplay,
        adminWaLink: adminWaLink
      }));
      return;
    }

    // POST /api/login
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const phone = (body.phone || '').trim();
      const users = readDb();

      // Demo User Budi Santoso
      if (phone === '081234567890') {
        const budi = users.find(u => u.phone === '081234567890') || {
          id: 'USR-BUDI-01',
          name: 'Budi Santoso',
          phone: '081234567890',
          email: 'budi.santoso@gmail.com',
          plan: 'TataDana PRO ✨',
          status: 'approved',
          isNewUser: false
        };
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user: budi }));
        return;
      }

      const user = findUserByQuery(users, { phone: phone });
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, message: 'Nomor WhatsApp belum terdaftar. Silakan daftar akun baru.' }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, user }));
      return;
    }

    // POST /api/approve
    if (pathname === '/api/approve' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const users = readDb();
      const user = users.find(u => u.id === userId);

      if (user) {
        user.status = 'approved';
        writeDb(users);
        console.log(`✅ [SUPER ADMIN] User Berhasil Disetujui (Approved): ${user.name} (${user.id})`);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // POST /api/unapprove
    if (pathname === '/api/unapprove' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const users = readDb();
      const user = users.find(u => u.id === userId);

      if (user) {
        user.status = 'unapproved';
        writeDb(users);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // POST /api/upgrade-premium
    if (pathname === '/api/upgrade-premium' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const users = readDb();
      const user = users.find(u => u.id === userId);

      if (user) {
        user.premiumUpgradePending = true;
        user.upgradeRequestedAt = new Date().toLocaleString('id-ID');
        user.upgradePaymentMethod = body.paymentMethod || 'Transfer BCA';
        writeDb(users);

        const waAdminMsg = encodeURIComponent(
          `Halo Super Admin TataDana (${ADMIN_CONFIG.email}),\n` +
          `Saya ingin melakukan verifikasi bukti pembayaran Upgrade PRO Lifetime (Rp99.000):\n` +
          `• ID Pengguna: ${user.id}\n` +
          `• Nama: ${user.name}\n` +
          `• No WhatsApp: ${user.phone}\n` +
          `• Metode Bayar: ${user.upgradePaymentMethod}\n\n` +
          `Mohon verifikasi pembayaran dan aktifkan status PRO Lifetime akun saya. Terima kasih!`
        );
        const adminWaLink = `https://wa.me/${ADMIN_CONFIG.waNumber}?text=${waAdminMsg}`;

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          user: user,
          adminWaNumber: ADMIN_CONFIG.waNumber,
          adminWaDisplay: ADMIN_CONFIG.waDisplay,
          adminWaLink: adminWaLink
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // POST /api/approve-premium
    if (pathname === '/api/approve-premium' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const users = readDb();
      const user = users.find(u => u.id === userId);

      if (user) {
        user.plan = 'TataDana PRO Lifetime';
        user.price = 99000;
        user.premiumUpgradePending = false;
        user.status = 'approved';
        writeDb(users);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // POST /api/reject-premium
    if (pathname === '/api/reject-premium' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const users = readDb();
      const user = users.find(u => u.id === userId);

      if (user) {
        user.premiumUpgradePending = false;
        writeDb(users);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // POST /api/impersonate
    if (pathname === '/api/impersonate' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const users = readDb();
      const user = users.find(u => u.id === userId);

      if (user) {
        // Super Admin impersonate unlocks user and upgrades to PRO
        user.plan = 'TataDana PRO Lifetime';
        user.status = 'approved';
        user.premiumUpgradePending = false;
        writeDb(users);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user, message: `Berhasil di-impersonate & diaktifkan PRO: ${user.name}` }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // POST /api/user/sync (Sync wallets, transactions from user dashboard)
    if (pathname === '/api/user/sync' && req.method === 'POST') {
      const body = await parseBody(req);
      const userId = body.userId;
      const phone = body.phone;
      const users = readDb();
      let user = findUserByQuery(users, { id: userId, phone: phone });

      if (user) {
        if (body.wallets) user.wallets = body.wallets;
        if (body.transactions) user.transactions = body.transactions;
        if (body.isNewUser !== undefined) user.isNewUser = body.isNewUser;
        user.lastUpdated = Date.now();
        writeDb(users);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, user }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'User tidak ditemukan' }));
      return;
    }

    // GET /api/telegram/status (Check Telegram Bot Pairing & Engine Status)
    if (pathname === '/api/telegram/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        botUsername: ADMIN_CONFIG.telegramBotUsername || 'TataDanaFinBot',
        botLink: ADMIN_CONFIG.telegramBotLink || 'https://t.me/TataDanaFinBot',
        pollingActive: telegramPollingActive,
        hasToken: !!ADMIN_CONFIG.telegramBotToken
      }));
      return;
    }

    // POST /api/telegram/webhook (Real Telegram Bot Webhook Receiver)
    if (pathname === '/api/telegram/webhook' && req.method === 'POST') {
      const update = await parseBody(req);
      await handleTelegramUpdate(update);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/telegram/simulate (Simulate message from Telegram with 100% parity)
    if (pathname === '/api/telegram/simulate' && req.method === 'POST') {
      const body = await parseBody(req);
      const text = body.text || '';
      const chatId = body.chatId || 101010;
      const userId = body.userId;
      const result = await processTelegramTextMessage(chatId, text, userId);
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        result
      }));
      return;
    }

    // Default unknown API
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint API tidak ditemukan' }));
    return;
  }

  // ==========================================
  // PAGE ROUTING
  // 1. /admin -> Super Admin Console (tatadana_admin.html)
  // 2. / or /user -> User Personal App (tatadana.html)
  // ==========================================
  if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin?')) {
    fs.readFile(ADMIN_HTML_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error loading TataDana Admin Console: ' + err.message);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // User route: / or /user or any user path
  fs.readFile(USER_HTML_FILE, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading TataDana application: ' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

if (!process.env.VERCEL) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`✅ TataDana Server running:`);
    console.log(`   📱 Link 2 (User App)       : http://localhost:${PORT}/ (atau http://localhost:${PORT}/user)`);
    console.log(`   👑 Link 1 (Super Admin VIP): http://localhost:${PORT}/admin`);
    if (ADMIN_CONFIG.telegramBotToken) {
      startTelegramPolling();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const ALT_PORT = 3001;
      console.log(`Port ${PORT} in use, trying ${ALT_PORT}...`);
      server.listen(ALT_PORT, '127.0.0.1', () => {
        console.log(`✅ TataDana Server running:`);
        console.log(`   📱 Link 2 (User App)       : http://localhost:${ALT_PORT}/`);
        console.log(`   👑 Link 1 (Super Admin VIP): http://localhost:${ALT_PORT}/admin`);
      });
    } else {
      console.error('Server error:', err);
    }
  });
}

module.exports = server;
