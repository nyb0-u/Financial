const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = typeof __dirname === "string" ? __dirname : ".";

function loadEnv() {
  let file;
  try {
    file = require("node:fs").readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }
  for (const line of file.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2").replace(/\\n/g, "\n");
  }
}

loadEnv();

const { CATEGORIES, CURRENCIES, manilaDate, normalizeTransaction, parseTransaction, summarize } = require("./src/finance");
const { readStore, updateStore, streamFirebaseChanges } = require("./src/store");
const {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  createToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  normalizeUsername,
  parseCookies,
  publicUser,
  safeEqual,
  sessionCookie,
  verifyPassword,
} = require("./src/auth");

const FIRST_ADMIN_EMAIL = "amjadamrullah911@gmail.com";
const FIRST_ADMIN_USERNAME = "BOOPAW";
const RESERVED_USERNAMES = new Set(["admin"]);
const PUBLIC_DIR = path.join(ROOT, "public");
let sheetTokenCache = null;
const authAttempts = new Map();
const telegramEditRequests = new Map();
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function requestedMonth(value) {
  const month = value || manilaDate().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw Object.assign(new Error("Bulan harus menggunakan format YYYY-MM."), { status: 400 });
  }
  return month;
}

function generatedUsername(user) {
  if (normalizeEmail(user.email) === FIRST_ADMIN_EMAIL) return FIRST_ADMIN_USERNAME;
  const localPart = typeof user.email === "string" ? user.email.split("@")[0] : "";
  const candidate = localPart.replace(/[^a-z0-9._-]/gi, "").replace(/^[^a-z0-9]+/i, "").slice(0, 32);
  return normalizeUsername(candidate) ? candidate : `user${user.id.replace(/[^a-f0-9]/gi, "").slice(0, 8)}`;
}

function assignMissingUsernames(users) {
  const claimed = new Set(
    ["admin", ...users.map((user) => normalizeUsername(user.username)).filter(Boolean)],
  );
  const missing = users
    .filter((user) => !normalizeUsername(user.username))
    .sort((left, right) => Number(normalizeEmail(right.email) === FIRST_ADMIN_EMAIL) - Number(normalizeEmail(left.email) === FIRST_ADMIN_EMAIL));

  for (const user of missing) {
    const base = generatedUsername(user);
    let username = base;
    let suffix = 2;
    while (claimed.has(normalizeUsername(username))) {
      const ending = String(suffix);
      suffix += 1;
      username = `${base.slice(0, 32 - ending.length)}${ending}`;
    }
    user.username = username;
    claimed.add(normalizeUsername(username));
  }
}

async function usersWithUsernames() {
  const store = await readStore();
  if (store.users.some((user) => !normalizeUsername(user.username))) {
    await updateStore((current) => assignMissingUsernames(current.users));
    return readStore();
  }
  return store;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Ukuran permintaan terlalu besar."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Format JSON tidak valid."), { status: 400 });
  }
}

function publicConfig() {
  return {
    telegram: telegramEnabled(),
    ai: Boolean(process.env.GEMINI_API_KEY),
    sheets: Boolean(
      process.env.GOOGLE_SHEETS_ID &&
      (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
        (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)),
    ),
    firebase: process.env.AUTOCATAT_STORE_BACKEND === "firebase",
    realtime: process.env.AUTOCATAT_REALTIME !== "false",
    telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || "",
    categories: CATEGORIES,
  };
}

function telegramEnabled() {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN &&
    (process.env.AUTOCATAT_TELEGRAM_WEBHOOK_ONLY !== "true" || process.env.TELEGRAM_WEBHOOK_SECRET),
  );
}

async function loadGoogleCredentials(environment = process.env) {
  let credentials;
  if (environment.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const credentialPath = path.resolve(ROOT, environment.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
    let contents;
    try {
      contents = await fs.readFile(credentialPath, "utf8");
    } catch (error) {
      if (
        error.code !== "ENOENT" ||
        !environment.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
        !environment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      ) {
        if (error.code === "ENOENT") {
          throw new Error(`File JSON Service Account tidak ditemukan: ${credentialPath}`);
        }
        throw error;
      }
      console.warn("Google Service Account file not found; falling back to GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.");
      credentials = {
        type: "service_account",
        client_email: environment.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: environment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      };
    }
    if (contents !== undefined) {
      try {
        credentials = JSON.parse(contents);
      } catch {
        throw new Error("File GOOGLE_SERVICE_ACCOUNT_KEY_FILE bukan JSON yang valid.");
      }
    }
  } else if (environment.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(environment.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON yang valid.");
    }
  } else if (environment.GOOGLE_SERVICE_ACCOUNT_EMAIL && environment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    credentials = {
      type: "service_account",
      client_email: environment.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: environment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    };
  } else {
    throw new Error(
      "Kredensial Google belum lengkap. Atur GOOGLE_SERVICE_ACCOUNT_KEY_FILE atau GOOGLE_SERVICE_ACCOUNT_EMAIL dan GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.",
    );
  }

  if (
    credentials.type !== "service_account" ||
    typeof credentials.client_email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credentials.client_email) ||
    typeof credentials.private_key !== "string" ||
    !credentials.private_key.includes("-----BEGIN PRIVATE KEY-----") ||
    !credentials.private_key.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error("JSON kredensial harus berisi type service_account, client_email, dan private_key yang valid.");
  }
  return { email: credentials.client_email, privateKey: credentials.private_key };
}

async function googleAccessToken() {
  if (sheetTokenCache && sheetTokenCache.expiresAt > Date.now() + 60_000) {
    return sheetTokenCache.value;
  }
  const { email, privateKey } = await loadGoogleCredentials();

  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claim = encode({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const input = `${header}.${claim}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${signature}`,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`Google OAuth gagal: ${result.error_description || result.error || response.status}`);
  }
  sheetTokenCache = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return result.access_token;
}

async function appendToSheet(transaction, userId) {
  if (!publicConfig().sheets) return null;
  const token = await googleAccessToken();
  const tabName = (process.env.GOOGLE_SHEETS_TAB || "Transaksi").replace(/'/g, "''");
  const range = encodeURIComponent(`'${tabName}'!A:H`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      values: [[transaction.date, transaction.type, transaction.description, transaction.category, transaction.wallet, transaction.amount, userId, transaction.currency]],
    }),
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(`Google Sheets gagal menyimpan transaksi: ${result.error?.message || response.status}`);
  }
  const result = await response.json();
  const row = result.updates?.updatedRange?.match(/![A-Z]+(\d+):/i);
  return row ? Number(row[1]) : null;
}

async function updateSheetRow(transaction) {
  if (!publicConfig().sheets || !transaction.sheetRow) return;
  const token = await googleAccessToken();
  const tabName = (process.env.GOOGLE_SHEETS_TAB || "Transaksi").replace(/'/g, "''");
  const range = encodeURIComponent(`'${tabName}'!A${transaction.sheetRow}:H${transaction.sheetRow}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID)}/values/${range}?valueInputOption=USER_ENTERED`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      values: [[transaction.date, transaction.type, transaction.description, transaction.category, transaction.wallet, transaction.amount, transaction.userId, transaction.currency || "IDR"]],
    }),
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(`Google Sheets gagal memperbarui transaksi: ${result.error?.message || response.status}`);
  }
}

async function deleteSheetRow(transaction) {
  if (!publicConfig().sheets || !transaction.sheetRow) return;
  const token = await googleAccessToken();
  const spreadsheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID)}?fields=sheets.properties(sheetId,title)`;
  const metadataResponse = await fetch(spreadsheetUrl, { headers: { Authorization: `Bearer ${token}` } });
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok) {
    throw new Error(`Google Sheets gagal memeriksa tab: ${metadata.error?.message || metadataResponse.status}`);
  }
  const tabName = process.env.GOOGLE_SHEETS_TAB || "Transaksi";
  const sheet = metadata.sheets?.find(({ properties }) => properties.title === tabName);
  if (!sheet) throw new Error(`Tab Google Sheets "${tabName}" tidak ditemukan.`);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID)}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: "ROWS",
              startIndex: transaction.sheetRow - 1,
              endIndex: transaction.sheetRow,
            },
          },
        }],
      }),
    },
  );
  if (!response.ok) {
    const result = await response.json();
    throw new Error(`Google Sheets gagal menghapus transaksi: ${result.error?.message || response.status}`);
  }
}

async function clearSheetRow(transaction) {
  if (!publicConfig().sheets || !transaction.sheetRow) return;
  const token = await googleAccessToken();
  const tabName = (process.env.GOOGLE_SHEETS_TAB || "Transaksi").replace(/'/g, "''");
  const range = encodeURIComponent(`'${tabName}'!A${transaction.sheetRow}:H${transaction.sheetRow}`);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID)}/values/${range}:clear`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (!response.ok) {
    const result = await response.json();
    throw new Error(`Google Sheets gagal menghapus transaksi: ${result.error?.message || response.status}`);
  }
}

async function addTransaction(userId, input, syncSheet = true, telegramUpdateId = null) {
  const result = await updateStore(async (store) => {
    if (telegramUpdateId !== null && store.processedTelegramUpdates?.includes(telegramUpdateId)) {
      return { transaction: null, sheetError: null, duplicate: true };
    }
    const transaction = {
      ...normalizeTransaction(input),
      id: crypto.randomUUID(),
      userId,
      telegramUpdateId,
      createdAt: new Date().toISOString(),
    };
    store.transactions.unshift(transaction);
    if (telegramUpdateId !== null) {
      store.processedTelegramUpdates ||= [];
      store.processedTelegramUpdates.push(telegramUpdateId);
      if (store.processedTelegramUpdates.length > 10_000) store.processedTelegramUpdates.splice(0, store.processedTelegramUpdates.length - 10_000);
    }
    return { transaction, duplicate: false };
  });
  if (result.duplicate || !syncSheet || !publicConfig().sheets) {
    return { ...result, sheetError: null };
  }
  let sheetError = null;
  try {
    const sheetRow = await appendToSheet(result.transaction, userId);
    if (sheetRow) {
      await updateStore((store) => {
        const stored = store.transactions.find(
          (item) => item.id === result.transaction.id && item.userId === userId,
        );
        if (stored) stored.sheetRow = sheetRow;
      });
      result.transaction.sheetRow = sheetRow;
    }
  } catch (error) {
    sheetError = error.message;
    console.error("Google Sheets append failed:", error.message);
  }
  return { ...result, sheetError };
}

function checkRequestOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw Object.assign(new Error("Origin permintaan tidak valid."), { status: 403 });
  }
  if (parsed.host !== request.headers.host) {
    throw Object.assign(new Error("Permintaan lintas situs ditolak."), { status: 403 });
  }
}

function isSecureRequest(request) {
  return Boolean(request.socket.encrypted || process.env.COOKIE_SECURE === "true");
}

function getAuthenticated(request, store) {
  const rawToken = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = store.sessions.find(
    (item) => item.tokenHash === tokenHash && item.expiresAt > Date.now(),
  );
  if (!session) return null;
  const user = store.users.find((item) => item.id === session.userId);
  return user && user.active !== false ? { user, session } : null;
}

function createUser(email, passwordHash, role = "user", username) {
  return {
    id: crypto.randomUUID(),
    username,
    email,
    passwordHash,
    role,
    monthlyBudget: Number(process.env.MONTHLY_BUDGET) || 5_000_000,
    telegramUserId: null,
    createdAt: new Date().toISOString(),
  };
}

function allowAuthAttempt(request) {
  const forwarded = request.headers["x-forwarded-for"]?.split(",")[0].trim();
  const key = process.env.TRUST_PROXY === "true" && forwarded
    ? forwarded
    : request.socket.remoteAddress || "unknown";
  const now = Date.now();
  if (authAttempts.size > 10_000) {
    for (const [address, attempt] of authAttempts) {
      if (attempt.expiresAt <= now) authAttempts.delete(address);
    }
  }
  const current = authAttempts.get(key);
  if (!current || current.expiresAt <= now) {
    authAttempts.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (current.count >= 12) return false;
  current.count += 1;
  return true;
}

function clearAuthAttempts(request) {
  const forwarded = request.headers["x-forwarded-for"]?.split(",")[0].trim();
  const key = process.env.TRUST_PROXY === "true" && forwarded
    ? forwarded
    : request.socket.remoteAddress || "unknown";
  authAttempts.delete(key);
}

function sheetOptions() {
  return { spreadsheet: Boolean(publicConfig().sheets), tab: process.env.GOOGLE_SHEETS_TAB || "Transaksi" };
}

async function createInvite(user, role = "user") {
  const inviteToken = createToken(24);
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await updateStore((store) => {
    store.invites = store.invites.filter((invite) => invite.expiresAt > Date.now() && !invite.usedAt);
    store.invites.push({
      id: crypto.randomUUID(),
      tokenHash: hashToken(inviteToken),
      createdBy: user.id,
      role,
      expiresAt,
      usedAt: null,
    });
  });
  return { inviteToken, expiresAt };
}

async function askGemini(prompt, attachment) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Fitur foto dan voice note membutuhkan GEMINI_API_KEY di file .env.");
  }
  const parts = [{ text: prompt }];
  if (attachment) {
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType,
        data: attachment.data.toString("base64"),
      },
    });
  }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              amount: { type: "NUMBER" },
              currency: { type: "STRING", enum: CURRENCIES },
              type: { type: "STRING", enum: ["income", "expense"] },
              description: { type: "STRING" },
              category: { type: "STRING", enum: CATEGORIES },
              wallet: { type: "STRING" },
              date: { type: "STRING" },
            },
            required: ["amount", "currency", "type", "description", "category", "wallet", "date"],
          },
        },
      }),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(`AI gagal memproses transaksi: ${result.error?.message || response.status}`);
  const content = result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  if (!content) throw new Error("AI tidak menemukan transaksi. Coba kirim foto yang lebih jelas atau jelaskan nominalnya.");
  return normalizeTransaction(JSON.parse(content));
}

async function telegramRequest(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} gagal: ${result.description || response.status}`);
  return result.result;
}

async function telegramFile(fileId) {
  const file = await telegramRequest("getFile", { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram gagal mengunduh lampiran: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new Error("Lampiran terlalu besar (maksimal 15 MB).");
  return buffer;
}

function telegramTransactionKeyboard(transactionId) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Edit", callback_data: `tx:e:${transactionId}` },
        { text: "🗑 Hapus", callback_data: `tx:d:${transactionId}` },
      ],
      [{ text: "📊 Dashboard", callback_data: "dashboard" }],
    ],
  };
}

function telegramTransactionText(transaction, sheetError = null) {
  const amount = formatMoney(transaction.amount, transaction.currency);
  return [
    "✅ Transaksi Berhasil Dicatat!",
    "",
    `📝 ${transaction.description} sebesar ${amount}.`,
    "Semoga barang-barangnya bermanfaat! ✨",
    "",
    `💰 Jumlah: ${amount}`,
    `📂 Kategori: ${transaction.type === "income" ? "Pemasukan" : "Pengeluaran"}/${transaction.category}`,
    `💳 Sumber Dana: ${transaction.wallet}`,
    `📅 Tanggal: ${transaction.date}`,
    sheetError ? `⚠️ Tersimpan, tetapi Google Sheets gagal: ${sheetError}` : "",
  ].filter(Boolean).join("\n");
}

function formatMoney(amount, currency = "IDR") {
  const symbols = { IDR: "Rp", USD: "$", PHP: "₱" };
  return `${symbols[currency] || symbols.IDR}${Number(amount).toLocaleString(currency === "IDR" ? "id-ID" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: currency === "IDR" ? 0 : 2,
  })}`;
}

function telegramDashboardText(summary) {
  const lines = CURRENCIES
    .filter((currency) => summary.byCurrency[currency].transactionCount || summary.byCurrency[currency].balance)
    .map((currency) => {
      const item = summary.byCurrency[currency];
      return `${currency}: masuk ${formatMoney(item.income, currency)} · keluar ${formatMoney(item.expenses, currency)} · saldo ${formatMoney(item.balance, currency)}`;
    });
  return `📊 Ringkasan bulan ini\n${lines.join("\n") || "Belum ada transaksi."}`;
}

async function parseTelegramTransaction(message, text) {
  if (message.photo?.length || message.voice || message.audio) {
    const fileId = message.photo?.at(-1)?.file_id || message.voice?.file_id || message.audio?.file_id;
    const mimeType = message.photo?.length ? "image/jpeg" : message.voice?.mime_type || message.audio?.mime_type || "audio/ogg";
    const attachment = { mimeType, data: await telegramFile(fileId) };
    const prompt = `Catat transaksi keuangan dari lampiran ini. Untuk gambar, baca struk. Untuk audio, pahami ucapan bahasa Indonesia. Kembalikan deskripsi asli, nominal, kode mata uang (IDR untuk Rupiah, USD untuk Dolar AS, PHP untuk Peso Filipina), jenis, kategori dari daftar, sumber dana, dan tanggal ISO YYYY-MM-DD. IDR tidak memakai desimal; USD/PHP maksimal 2 desimal. Jika mata uang tidak jelas, gunakan IDR. Jika tanggal tidak disebut, gunakan ${manilaDate()}. Jangan menebak nominal yang tidak terbaca. Caption/konteks: ${text || "-"}`;
    return askGemini(prompt, attachment);
  }
  return process.env.GEMINI_API_KEY
    ? askGemini(`Ubah pesan transaksi berikut menjadi catatan keuangan. Sertakan kode mata uang: IDR untuk Rupiah, USD untuk Dolar AS, PHP untuk Peso Filipina. Jika tidak disebut, gunakan IDR. Nominal IDR bilangan bulat; USD/PHP maksimal 2 desimal. Kategori harus sesuai pilihan. Tanggal tidak disebut: ${manilaDate()}. Pesan: ${text}`)
    : parseTransaction(text);
}

async function handleTelegramCallback(query) {
  if (!query?.id || !query.from?.id || query.message?.chat?.type !== "private") return;
  const chatId = query.message.chat.id;
  const store = await usersWithUsernames();
  const user = store.users.find((item) => item.telegramUserId === String(query.from.id) && item.active !== false);
  if (!user) {
    await telegramRequest("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Hubungkan akun Telegram ke Autocatat terlebih dahulu.",
      show_alert: true,
    });
    return;
  }
  const data = query.data || "";
  if (data === "dashboard") {
    const transactions = store.transactions.filter((item) => item.userId === user.id);
    const summary = summarize(transactions, manilaDate().slice(0, 7), user.monthlyBudget);
    await telegramRequest("answerCallbackQuery", { callback_query_id: query.id });
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: telegramDashboardText(summary),
    });
    return;
  }
  const action = data.match(/^tx:([ed]):([a-f0-9-]{36})$/i);
  if (!action) {
    await telegramRequest("answerCallbackQuery", { callback_query_id: query.id, text: "Tombol tidak dikenal." });
    return;
  }
  const transaction = store.transactions.find(
    (item) => item.id === action[2] && item.userId === user.id,
  );
  if (!transaction) {
    await telegramRequest("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Transaksi tidak ditemukan atau sudah dihapus.",
      show_alert: true,
    });
    return;
  }
  if (action[1] === "e") {
    const prompt = await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: "Kirim transaksi pengganti sebagai balasan untuk pesan ini. Contoh: makan siang 35rb.",
      reply_markup: { force_reply: true, selective: true },
    });
    telegramEditRequests.set(`${user.id}:${chatId}`, {
      transactionId: transaction.id,
      promptMessageId: prompt.message_id,
    });
    await telegramRequest("answerCallbackQuery", { callback_query_id: query.id, text: "Silakan kirim rincian transaksi yang baru." });
    return;
  }

  const removed = await updateStore((current) => {
    const index = current.transactions.findIndex(
      (item) => item.id === transaction.id && item.userId === user.id,
    );
    if (index < 0) return null;
    return current.transactions.splice(index, 1)[0];
  });
  if (!removed) {
    await telegramRequest("answerCallbackQuery", { callback_query_id: query.id, text: "Transaksi sudah tidak ditemukan." });
    return;
  }
  let sheetError = null;
  try {
    await clearSheetRow(removed);
  } catch (error) {
    sheetError = error.message;
    console.error("Google Sheets delete failed:", error.message);
  }
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: query.id,
    text: sheetError ? "Transaksi dihapus, tetapi sinkronisasi Sheets gagal." : "Transaksi berhasil dihapus.",
  });
  await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `🗑 Transaksi berhasil dihapus.${sheetError ? `\n⚠️ Google Sheets gagal: ${sheetError}` : ""}`,
    reply_markup: {
      inline_keyboard: [[{ text: "📊 Dashboard", callback_data: "dashboard" }]],
    },
  });
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return;
  }
  const message = update.message;
  if (!message?.chat?.id || message.chat.type !== "private" || !message.from?.id) return;
  const chatId = message.chat.id;
  const reply = (text) => telegramRequest("sendMessage", { chat_id: chatId, text });
  const text = (message.text || message.caption || "").trim();
  const store = await usersWithUsernames();
  let user = store.users.find((item) => item.telegramUserId === String(message.from.id));
  const startCommand = text === "/start" || text.startsWith("/start ");
  const linkMatch = text.match(/^\/link(?:@\w+)?\s+([A-Za-z0-9_-]{20,80})$/);
  if (linkMatch) {
    const tokenHash = hashToken(linkMatch[1]);
    try {
      await updateStore((current) => {
        const linkCode = current.linkCodes.find(
          (item) => item.tokenHash === tokenHash && item.expiresAt > Date.now() && !item.usedAt,
        );
        if (!linkCode) {
          throw Object.assign(new Error("Kode tautan tidak valid atau sudah kedaluwarsa."), { status: 400 });
        }
        const target = current.users.find((item) => item.id === linkCode.userId);
        const existing = current.users.find((item) => item.telegramUserId === String(message.from.id));
        if (!target || target.active === false) throw new Error("Akun Autocatat untuk kode ini tidak ditemukan atau sudah nonaktif.");
        if (existing && existing.id !== target.id) {
          throw Object.assign(new Error("Akun Telegram ini sudah terhubung ke akun Autocatat lain."), { status: 409 });
        }
        if (target.telegramUserId && target.telegramUserId !== String(message.from.id)) {
          throw Object.assign(new Error("Akun Autocatat ini sudah tertaut ke akun Telegram lain."), { status: 409 });
        }
        target.telegramUserId = String(message.from.id);
        linkCode.usedAt = Date.now();
        user = target;
      });
      await reply("✅ Telegram berhasil ditautkan ke akun Autocatat kamu. Transaksi pribadi kini bisa dicatat lewat chat ini.");
    } catch (error) {
      await reply(`Belum bisa menautkan akun: ${error.message}`);
    }
    return;
  }
  if (!user) {
    if (startCommand) {
      await reply("Selamat datang di Autocatat! Buat akun atau masuk ke dashboard Autocatat terlebih dahulu, lalu buka Pengaturan → Hubungkan Telegram untuk membuat kode tautan. Setelah itu kirim /link KODE ke bot ini.");
    } else {
      await reply("Akun Telegram ini belum terhubung. Kirim /start untuk petunjuk menghubungkan akun dari dashboard Autocatat.");
    }
    return;
  }
  const editKey = `${user.id}:${chatId}`;
  const editRequest = telegramEditRequests.get(editKey);
  if (editRequest && message.reply_to_message?.message_id === editRequest.promptMessageId) {
    try {
      const input = await parseTelegramTransaction(message, text);
      const updated = await updateStore((current) => {
        const index = current.transactions.findIndex(
          (item) => item.id === editRequest.transactionId && item.userId === user.id,
        );
        if (index < 0) return null;
        current.transactions[index] = {
          ...current.transactions[index],
          ...normalizeTransaction(input),
          updatedAt: new Date().toISOString(),
        };
        return current.transactions[index];
      });
      if (!updated) {
        telegramEditRequests.delete(editKey);
        await reply("Transaksi tidak ditemukan atau sudah dihapus.");
        return;
      }
      telegramEditRequests.delete(editKey);
      let sheetError = null;
      try {
        await updateSheetRow(updated);
      } catch (error) {
        sheetError = error.message;
        console.error("Google Sheets update failed:", error.message);
      }
      await telegramRequest("sendMessage", {
        chat_id: chatId,
        text: telegramTransactionText(updated, sheetError),
        reply_markup: telegramTransactionKeyboard(updated.id),
      });
    } catch (error) {
      console.error("Telegram transaction edit failed:", error.message);
      await reply(`Belum berhasil mengubah transaksi: ${error.message}`);
    }
    return;
  }
  if (startCommand || text === "/help") {
    await reply(
      `Hai! Autocatat sudah terhubung ke ${user.username}. Kirim transaksi seperti “makan siang 35rb”, foto struk, atau voice note. Gunakan /dashboard untuk ringkasan bulan ini.`,
    );
    return;
  }
  if (text === "/dashboard") {
    const transactions = store.transactions.filter((item) => item.userId === user.id);
    const summary = summarize(transactions, manilaDate().slice(0, 7), user.monthlyBudget);
    await reply(telegramDashboardText(summary));
    return;
  }
  if (text.startsWith("/")) {
    await reply("Perintah tersedia: /start, /help, /dashboard. Untuk menambah transaksi, kirim deskripsi atau foto/voice note.");
    return;
  }

  try {
    const input = await parseTelegramTransaction(message, text);
    const { transaction, sheetError, duplicate } = await addTransaction(user.id, input, true, update.update_id ?? null);
    if (duplicate) {
      await reply("ℹ️ Pesan transaksi ini sudah pernah diproses, jadi tidak dicatat ulang.");
      return;
    }
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: telegramTransactionText(transaction, sheetError),
      reply_markup: telegramTransactionKeyboard(transaction.id),
    });
  } catch (error) {
    console.error("Telegram transaction failed:", error.message);
    await reply(`Belum berhasil dicatat: ${error.message}`);
  }
}

async function startTelegramPolling() {
  try {
    const bot = await telegramRequest("getMe", {});
    process.env.TELEGRAM_BOT_USERNAME = bot.username || "";
    console.log(`Telegram terhubung sebagai @${process.env.TELEGRAM_BOT_USERNAME}`);
  } catch (error) {
    console.error("Telegram bot initialization failed:", error.message);
    return;
  }
  try {
    await telegramRequest("setMyCommands", {
      commands: [
        { command: "start", description: "Mulai menggunakan Autocatat" },
        { command: "help", description: "Lihat bantuan penggunaan" },
        { command: "dashboard", description: "Lihat ringkasan keuangan" },
      ],
    });
  } catch (error) {
    console.error("Telegram command menu setup failed:", error.message);
  }
  let offset = 0;
  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error("Telegram polling failed:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function serveStatic(pathname, response) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    throw error;
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const method = request.method;
    const pathname = url.pathname;
    const cookieSecure = isSecureRequest(request);

    if ((method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
      await serveStatic(pathname, response);
      return;
    }

    if (pathname === "/api/auth/status" && method === "GET") {
      const store = await usersWithUsernames();
      sendJson(response, 200, {
        hasUsers: store.users.length > 0,
        setupEnabled: store.users.length === 0 && Boolean(process.env.ADMIN_SETUP_KEY),
        registrationEnabled: store.users.length > 0,
      });
      return;
    }

    if (pathname === "/api/auth/setup" && method === "POST") {
      checkRequestOrigin(request);
      if (!allowAuthAttempt(request)) {
        sendJson(response, 429, { error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
        return;
      }
      const input = await readBody(request, 20_000);
      if (!process.env.ADMIN_SETUP_KEY || !safeEqual(input.setupKey, process.env.ADMIN_SETUP_KEY)) {
        sendJson(response, 403, { error: "Kunci setup admin salah atau belum dikonfigurasi." });
        return;
      }
      const passwordHash = await hashPassword(input.password);
      const user = createUser(FIRST_ADMIN_EMAIL, passwordHash, "admin", FIRST_ADMIN_USERNAME);
      const authSession = createSession(user.id);
      await updateStore((store) => {
        if (store.users.length) {
          throw Object.assign(new Error("Akun admin pertama sudah dibuat."), { status: 409 });
        }
        store.users.push(user);
        store.transactions = store.transactions.map((transaction) => ({ ...transaction, userId: user.id }));
        store.sessions = [authSession.session];
      });
      clearAuthAttempts(request);
      sendJson(response, 201, { user: publicUser(user), csrfToken: authSession.session.csrfToken }, {
        "Set-Cookie": sessionCookie(authSession.token, cookieSecure),
      });
      return;
    }

    if (pathname === "/api/auth/register" && method === "POST") {
      checkRequestOrigin(request);
      if (!allowAuthAttempt(request)) {
        sendJson(response, 429, { error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
        return;
      }
      const input = await readBody(request, 20_000);
      const username = typeof input.username === "string" ? input.username.trim() : "";
      const usernameKey = normalizeUsername(username);
      if (!usernameKey) {
        sendJson(response, 400, { error: "Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung." });
        return;
      }
      if (RESERVED_USERNAMES.has(usernameKey)) {
        sendJson(response, 400, { error: "Username admin tidak boleh digunakan." });
        return;
      }
      const email = normalizeEmail(input.email);
      if (!email) {
        sendJson(response, 400, { error: "Alamat email tidak valid." });
        return;
      }
      const beforeRegistration = await usersWithUsernames();
      if (!beforeRegistration.users.length) {
        sendJson(response, 403, { error: "Admin pertama harus dibuat sebelum pendaftaran akun dibuka." });
        return;
      }
      if (beforeRegistration.users.some((item) => normalizeUsername(item.username) === usernameKey)) {
        sendJson(response, 409, { error: "Username sudah digunakan." });
        return;
      }
      if (beforeRegistration.users.some((item) => item.email === email)) {
        sendJson(response, 409, { error: "Email sudah terdaftar." });
        return;
      }
      const passwordHash = await hashPassword(input.password);
      const user = createUser(email, passwordHash, "user", username);
      const authSession = createSession(user.id);
      await updateStore((store) => {
        if (!store.users.length) {
          throw Object.assign(new Error("Admin pertama harus dibuat sebelum pendaftaran akun dibuka."), { status: 403 });
        }
        if (store.users.some((item) => item.email === email)) {
          throw Object.assign(new Error("Email sudah terdaftar."), { status: 409 });
        }
        if (store.users.some((item) => normalizeUsername(item.username) === usernameKey)) {
          throw Object.assign(new Error("Username sudah digunakan."), { status: 409 });
        }
        store.users.push(user);
        store.sessions = store.sessions.filter((item) => item.expiresAt > Date.now());
        store.sessions.push(authSession.session);
      });
      clearAuthAttempts(request);
      sendJson(response, 201, { user: publicUser(user), csrfToken: authSession.session.csrfToken }, {
        "Set-Cookie": sessionCookie(authSession.token, cookieSecure),
      });
      return;
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      checkRequestOrigin(request);
      if (!allowAuthAttempt(request)) {
        sendJson(response, 429, { error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
        return;
      }
      const input = await readBody(request, 20_000);
      const username = normalizeUsername(input.username);
      const store = await usersWithUsernames();
      const user = store.users.find((item) => normalizeUsername(item.username) === username && item.active !== false);
      const passwordHash = user?.passwordHash || `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;
      if (!(await verifyPassword(typeof input.password === "string" ? input.password : "", passwordHash)) || !user) {
        sendJson(response, 401, { error: "Username atau kata sandi salah." });
        return;
      }
      const authSession = createSession(user.id);
      await updateStore((current) => {
        current.sessions = current.sessions.filter((item) => item.expiresAt > Date.now());
        current.sessions.push(authSession.session);
      });
      clearAuthAttempts(request);
      sendJson(response, 200, { user: publicUser(user), csrfToken: authSession.session.csrfToken }, {
        "Set-Cookie": sessionCookie(authSession.token, cookieSecure),
      });
      return;
    }

    if (pathname.startsWith("/api/auth/")) {
      checkRequestOrigin(request);
      const store = await usersWithUsernames();
      const auth = getAuthenticated(request, store);
      if (!auth) {
        sendJson(response, 401, { error: "Silakan masuk untuk melanjutkan." }, {
          "Set-Cookie": clearSessionCookie(cookieSecure),
        });
        return;
      }
      if (method !== "GET" && request.headers["x-csrf-token"] !== auth.session.csrfToken) {
        sendJson(response, 403, { error: "Token keamanan tidak valid. Muat ulang halaman dan coba lagi." });
        return;
      }
      if (pathname === "/api/auth/me" && method === "GET") {
        sendJson(response, 200, { user: publicUser(auth.user), csrfToken: auth.session.csrfToken });
        return;
      }
      if (pathname === "/api/auth/logout" && method === "POST") {
        await updateStore((current) => {
          current.sessions = current.sessions.filter((item) => item.tokenHash !== auth.session.tokenHash);
        });
        sendJson(response, 200, { success: true }, { "Set-Cookie": clearSessionCookie(cookieSecure) });
        return;
      }
      if (pathname === "/api/auth/password" && method === "PATCH") {
        const input = await readBody(request, 20_000);
        if (!(await verifyPassword(input.currentPassword, auth.user.passwordHash))) {
          sendJson(response, 400, { error: "Kata sandi saat ini salah." });
          return;
        }
        const passwordHash = await hashPassword(input.newPassword);
        await updateStore((current) => {
          const user = current.users.find((item) => item.id === auth.user.id);
          user.passwordHash = passwordHash;
          current.sessions = current.sessions.filter((item) => item.userId !== user.id || item.tokenHash === auth.session.tokenHash);
        });
        sendJson(response, 200, { success: true });
        return;
      }
      sendJson(response, 404, { error: "Endpoint autentikasi tidak ditemukan." });
      return;
    }

    if (!pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Halaman tidak ditemukan." });
      return;
    }

    const store = await usersWithUsernames();
    const auth = getAuthenticated(request, store);
    if (!auth) {
      sendJson(response, 401, { error: "Silakan masuk untuk melanjutkan." });
      return;
    }
    if (method !== "GET") {
      checkRequestOrigin(request);
      if (request.headers["x-csrf-token"] !== auth.session.csrfToken) {
        sendJson(response, 403, { error: "Token keamanan tidak valid. Muat ulang halaman dan coba lagi." });
        return;
      }
    }
    const userId = auth.user.id;

    if (pathname === "/api/vault" && method === "GET") {
      sendJson(response, 200, {
        vault: (store.vaults || []).find((item) => item.userId === userId) || null,
      });
      return;
    }
    if (pathname === "/api/vault" && method === "PUT") {
      const input = await readBody(request, 1_100_000);
      const base64Url = /^[A-Za-z0-9_-]+$/;
      if (
        typeof input.salt !== "string" ||
        !/^[A-Za-z0-9_-]{22}$/.test(input.salt) ||
        typeof input.iv !== "string" ||
        !/^[A-Za-z0-9_-]{16}$/.test(input.iv) ||
        typeof input.ciphertext !== "string" ||
        input.ciphertext.length < 22 ||
        input.ciphertext.length > 1_000_000 ||
        !base64Url.test(input.ciphertext) ||
        !(input.expectedUpdatedAt === null || Number.isSafeInteger(input.expectedUpdatedAt))
      ) {
        sendJson(response, 400, { error: "Payload vault terenkripsi tidak valid." });
        return;
      }
      const updatedAt = Date.now();
      let conflict = false;
      await updateStore((current) => {
        current.vaults ||= [];
        const index = current.vaults.findIndex((item) => item.userId === userId);
        const existing = index === -1 ? null : current.vaults[index];
        if ((existing?.updatedAt ?? null) !== input.expectedUpdatedAt) {
          conflict = true;
          return;
        }
        const vault = {
          userId,
          salt: input.salt,
          iv: input.iv,
          ciphertext: input.ciphertext,
          updatedAt,
        };
        if (index === -1) current.vaults.push(vault);
        else current.vaults[index] = vault;
      });
      if (conflict) {
        sendJson(response, 409, { error: "Vault berubah di sesi lain. Muat ulang vault sebelum menyimpan." });
        return;
      }
      sendJson(response, 200, { updatedAt });
      return;
    }

    if (pathname === "/api/events" && method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      response.write(": connected\n\n");
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(": heartbeat\n\n");
      }, 25_000);
      response.on("close", () => {
        clearInterval(heartbeat);
        controller.abort();
      });
      void streamFirebaseChanges(
        () => {
          if (!response.destroyed) response.write("event: refresh\ndata: {}\n\n");
        },
        {
          signal: controller.signal,
          onStatus: (status) => {
            if (!response.destroyed) response.write(`event: firebase-status\ndata: ${JSON.stringify(status)}\n\n`);
          },
        },
      ).catch((error) => {
        console.error("Firebase realtime stream stopped:", error.message);
        if (!response.destroyed) response.write("event: firebase-status\ndata: \"reconnecting\"\n\n");
      });
      return;
    }

    if (pathname === "/api/config" && method === "GET") {
      sendJson(response, 200, { ...publicConfig(), user: publicUser(auth.user) });
      return;
    }
    if (pathname === "/api/account" && method === "GET") {
      sendJson(response, 200, {
        user: publicUser(auth.user),
        monthlyBudget: auth.user.monthlyBudget,
        telegramLinked: Boolean(auth.user.telegramUserId),
        sheet: sheetOptions(),
      });
      return;
    }
    if (pathname === "/api/account" && method === "PATCH") {
      const input = await readBody(request, 20_000);
      const budget = Number(input.monthlyBudget);
      if (!Number.isSafeInteger(budget) || budget < 0 || budget > 1_000_000_000_000) {
        sendJson(response, 400, { error: "Anggaran bulanan harus bilangan rupiah antara 0 dan 1.000.000.000.000." });
        return;
      }
      await updateStore((current) => {
        const user = current.users.find((item) => item.id === userId);
        user.monthlyBudget = budget;
      });
      sendJson(response, 200, { success: true, monthlyBudget: budget });
      return;
    }
    if (pathname === "/api/telegram/link-code" && method === "POST") {
      if (!telegramEnabled()) {
        sendJson(response, 503, { error: "Telegram bot belum dikonfigurasi." });
        return;
      }
      const code = createToken(18);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      await updateStore((current) => {
        const user = current.users.find((item) => item.id === userId);
        if (user.telegramUserId) {
          throw Object.assign(new Error("Putuskan tautan Telegram lama terlebih dahulu."), { status: 409 });
        }
        current.linkCodes = current.linkCodes.filter((item) => item.expiresAt > Date.now() && !item.usedAt);
        current.linkCodes.push({ tokenHash: hashToken(code), userId, expiresAt, usedAt: null });
      });
      sendJson(response, 201, {
        code,
        command: `/link ${code}`,
        botUsername: process.env.TELEGRAM_BOT_USERNAME || "",
        expiresAt,
      });
      return;
    }
    if (pathname === "/api/telegram/unlink" && method === "POST") {
      await updateStore((current) => {
        const user = current.users.find((item) => item.id === userId);
        user.telegramUserId = null;
        current.linkCodes = current.linkCodes.filter((item) => item.userId !== userId);
      });
      sendJson(response, 200, { success: true });
      return;
    }
    if (pathname === "/api/admin/users" && method === "GET") {
      if (auth.user.role !== "admin") {
        sendJson(response, 403, { error: "Hanya admin yang dapat mengelola akun." });
        return;
      }
      const current = await usersWithUsernames();
      sendJson(response, 200, {
        users: current.users.map((user) => ({ ...publicUser(user), active: user.active !== false })),
      });
      return;
    }
    if (pathname === "/api/admin/invites" && method === "POST") {
      if (auth.user.role !== "admin") {
        sendJson(response, 403, { error: "Hanya admin yang dapat membuat undangan." });
        return;
      }
      const input = await readBody(request, 20_000);
      const role = input.role === "admin" ? "admin" : "user";
      const invite = await createInvite(auth.user, role);
      sendJson(response, 201, invite);
      return;
    }
    const adminUserRoute = pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/i);
    if (adminUserRoute && method === "DELETE") {
      if (auth.user.role !== "admin") {
        sendJson(response, 403, { error: "Hanya admin yang dapat menonaktifkan akun." });
        return;
      }
      if (adminUserRoute[1] === userId) {
        sendJson(response, 400, { error: "Admin tidak dapat menonaktifkan akunnya sendiri." });
        return;
      }
      const disabled = await updateStore((current) => {
        const target = current.users.find((user) => user.id === adminUserRoute[1]);
        if (!target || target.active === false) return false;
        if (target.role === "admin" && current.users.filter((user) => user.role === "admin" && user.active !== false).length <= 1) {
          throw Object.assign(new Error("Tidak bisa menonaktifkan admin aktif terakhir."), { status: 409 });
        }
        target.active = false;
        target.telegramUserId = null;
        current.sessions = current.sessions.filter((session) => session.userId !== target.id);
        return true;
      });
      if (!disabled) {
        sendJson(response, 404, { error: "Akun tidak ditemukan atau sudah nonaktif." });
        return;
      }
      sendJson(response, 200, { success: true });
      return;
    }
    if (pathname === "/api/transactions" && method === "GET") {
      const month = requestedMonth(url.searchParams.get("month"));
      let transactions = store.transactions.filter(
        (item) => item.userId === userId && item.date.startsWith(month),
      );
      const type = url.searchParams.get("type");
      const category = url.searchParams.get("category");
      const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase("id-ID").slice(0, 100);
      if (type === "income" || type === "expense") transactions = transactions.filter((item) => item.type === type);
      if (category) transactions = transactions.filter((item) => item.category === category);
      if (query) transactions = transactions.filter((item) => item.description.toLocaleLowerCase("id-ID").includes(query));
      sendJson(response, 200, { transactions });
      return;
    }
    if (pathname === "/api/summary" && method === "GET") {
      const month = requestedMonth(url.searchParams.get("month"));
      const transactions = store.transactions.filter((item) => item.userId === userId);
      sendJson(response, 200, summarize(transactions, month, auth.user.monthlyBudget));
      return;
    }
    if (pathname === "/api/transactions" && method === "POST") {
      const input = await readBody(request);
      const result = await addTransaction(userId, input);
      sendJson(response, 201, result);
      return;
    }
    const transactionRoute = pathname.match(/^\/api\/transactions\/([a-f0-9-]+)$/i);
    if (transactionRoute && method === "PATCH") {
      const input = await readBody(request);
      const result = await updateStore(async (current) => {
        const index = current.transactions.findIndex(
          (transaction) => transaction.id === transactionRoute[1] && transaction.userId === userId,
        );
        if (index < 0) return null;
        const updated = {
          ...current.transactions[index],
          ...normalizeTransaction(input),
          updatedAt: new Date().toISOString(),
        };
        current.transactions[index] = updated;
        return { transaction: updated };
      });
      if (!result) {
        sendJson(response, 404, { error: "Transaksi tidak ditemukan." });
        return;
      }
      let sheetError = null;
      try {
        await updateSheetRow(result.transaction);
      } catch (error) {
        sheetError = error.message;
        console.error("Google Sheets update failed:", error.message);
      }
      result.sheetError = sheetError;
      sendJson(response, 200, result);
      return;
    }
    if (transactionRoute && method === "DELETE") {
      const result = await updateStore(async (current) => {
        const removed = current.transactions.find(
          (transaction) => transaction.id === transactionRoute[1] && transaction.userId === userId,
        );
        if (!removed) return null;
        current.transactions = current.transactions.filter((transaction) => transaction.id !== transactionRoute[1]);
        return { success: true, removed };
      });
      if (!result) {
        sendJson(response, 404, { error: "Transaksi tidak ditemukan." });
        return;
      }
      let sheetError = null;
      try {
        await clearSheetRow(result.removed);
      } catch (error) {
        sheetError = error.message;
        console.error("Google Sheets delete failed:", error.message);
      }
      delete result.removed;
      result.sheetError = sheetError;
      sendJson(response, 200, result);
      return;
    }
    sendJson(response, 404, { error: "Endpoint tidak ditemukan." });
  } catch (error) {
    if (error.status === 503) {
      console.error("Firebase backend unavailable:", error.message);
      sendJson(response, 503, {
        error: "Firebase tidak dapat diakses. Periksa FIREBASE_DATABASE_URL dan izin Service Account.",
      });
      return;
    }
    if (error.status && error.status < 500) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error("Request failed:", error.message);
    sendJson(response, 500, { error: "Terjadi kesalahan server. Periksa log aplikasi." });
  }
}

function createServer() {
  return http.createServer((request, response) => {
    void handleRequest(request, response);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Autocatat berjalan di http://${host}:${port}`);
    if (host !== "127.0.0.1" && host !== "localhost" && process.env.NODE_ENV !== "production") {
      console.warn("Peringatan: server menerima koneksi jaringan. Gunakan HTTPS reverse proxy sebelum menerima kata sandi lewat internet.");
    }
    if (!process.env.ADMIN_SETUP_KEY) {
      console.warn("ADMIN_SETUP_KEY kosong atau tidak terbaca dari .env/process environment. Setup admin pertama dinonaktifkan; gunakan scripts/generate-admin-key.js untuk membuat key.");
    }
    if (process.env.TELEGRAM_BOT_TOKEN) void startTelegramPolling();
    else console.log("Telegram belum terhubung. Isi TELEGRAM_BOT_TOKEN pada .env.");
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = {
  createServer,
  parseTransaction,
  summarize,
  addTransaction,
  handleTelegramUpdate,
  telegramTransactionKeyboard,
  telegramTransactionText,
  telegramDashboardText,
  loadGoogleCredentials,
  checkRequestOrigin,
  getAuthenticated,
};
