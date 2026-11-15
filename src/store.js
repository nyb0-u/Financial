const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MODULE_DIR = typeof __dirname === "string" ? __dirname : ".";
const DEFAULT_DATA_DIR = path.join(MODULE_DIR, "..", "data");
const STORE_FILE = process.env.AUTOCATAT_STORE_FILE || path.join(DEFAULT_DATA_DIR, "store.json");
const DATA_DIR = path.dirname(STORE_FILE);
const LEGACY_FILE = process.env.AUTOCATAT_LEGACY_FILE || path.join(DATA_DIR, "transactions.json");
let mutationQueue = Promise.resolve();
let firebaseTokenCache = null;

function firebaseKeyFileCandidates(projectRoot, configuredKeyFile) {
  const candidates = [
    configuredKeyFile ? path.resolve(projectRoot, configuredKeyFile) : null,
    path.join(projectRoot, "firebase-service-account.json"),
    path.join(projectRoot, "credentials", "firebase-service-account.json"),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function firebaseConfig() {
  const url = process.env.FIREBASE_DATABASE_URL;
  const keyFile = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE?.trim();
  const credentialsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const hasCredentialsJson = typeof credentialsJson === "string" && Boolean(credentialsJson.trim());
  if (process.env.AUTOCATAT_STORE_BACKEND !== "firebase") return null;
  if (!url) {
    throw new Error("Firebase Realtime Database belum dikonfigurasi. Isi FIREBASE_DATABASE_URL.");
  }
  const parsed = new URL(url);
  const supportedHost = parsed.hostname.endsWith(".firebaseio.com") ||
    parsed.hostname.endsWith(".firebasedatabase.app");
  if (parsed.protocol !== "https:" || !supportedHost || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("FIREBASE_DATABASE_URL harus berupa URL HTTPS Firebase Realtime Database yang valid.");
  }
  const projectRoot = path.resolve(MODULE_DIR, "..");
  const configuredKeyFile = keyFile ? path.resolve(projectRoot, keyFile) : null;
  return {
    baseUrl: url.replace(/\/+$/, ""),
    configuredKeyFile,
    keyFiles: hasCredentialsJson ? [] : firebaseKeyFileCandidates(projectRoot, keyFile),
    credentialsJson: hasCredentialsJson ? credentialsJson : null,
  };
}

async function readFirebaseCredentialFile(keyFiles) {
  const missingPaths = [];
  for (const filePath of keyFiles) {
    try {
      return { filePath, contents: await fs.readFile(filePath, "utf8") };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missingPaths.push(filePath);
    }
  }
  throw new Error(`File kredensial Firebase tidak ditemukan. Path yang diperiksa: ${missingPaths.join(", ")}`);
}

async function firebaseCredentials(config) {
  let credential;
  if (config.credentialsJson) {
    try {
      credential = JSON.parse(config.credentialsJson);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON bukan JSON yang valid.");
    }
  } else {
    const { filePath, contents } = await readFirebaseCredentialFile(config.keyFiles);
    if (config.configuredKeyFile && filePath !== config.configuredKeyFile) {
      console.warn(`Firebase credential file not found at configured path; using fallback: ${filePath}`);
    }
    try {
      credential = JSON.parse(contents);
    } catch {
      throw new Error(`File kredensial Firebase bukan JSON yang valid: ${filePath}`);
    }
  }
  if (
    credential.type !== "service_account" ||
    typeof credential.client_email !== "string" ||
    typeof credential.private_key !== "string" ||
    !credential.private_key.includes("-----BEGIN PRIVATE KEY-----") ||
    !credential.private_key.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error("Kredensial Firebase harus berupa JSON key Service Account yang valid.");
  }
  return credential;
}

async function firebaseAccessToken(config) {
  const credential = await firebaseCredentials(config);
  const cacheKey = `${credential.client_email}:${credential.private_key_id || ""}`;
  if (firebaseTokenCache?.key === cacheKey && firebaseTokenCache.expiresAt > Date.now() + 60_000) {
    return firebaseTokenCache.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claim = encode({
    iss: credential.client_email,
    scope: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/firebase.database",
    ].join(" "),
    aud: credential.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const input = `${header}.${claim}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), credential.private_key).toString("base64url");
  const response = await fetch(credential.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${signature}`,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`Autentikasi Firebase gagal: ${result.error_description || result.error || response.status}`);
  }
  firebaseTokenCache = {
    key: cacheKey,
    token: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
  return result.access_token;
}

function firebaseStoreUrl(config) {
  return `${config.baseUrl}/autocatat.json`;
}

async function firebaseError(response) {
  const details = await response.text();
  if (response.status === 401 || response.status === 403) {
    return Object.assign(new Error(
      `Firebase menolak akses (${response.status}). Periksa service account dan izinnya pada proyek Firebase tujuan.${details ? ` ${details.slice(0, 300)}` : ""}`,
    ), { status: 503 });
  }
  return new Error(`Firebase Realtime Database merespons ${response.status}.${details ? ` ${details.slice(0, 300)}` : ""}`);
}

async function firebaseRead(config) {
  const token = await firebaseAccessToken(config);
  const response = await fetch(firebaseStoreUrl(config), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Firebase-ETag": "true",
    },
  });
  if (!response.ok) throw await firebaseError(response);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("Firebase tidak mengirim ETag; penyimpanan transaksional dibatalkan untuk mencegah kehilangan perubahan.");
  return { store: await response.json(), etag };
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, "utf8"));
    if (
      !parsed ||
      !Array.isArray(parsed.users) ||
      !Array.isArray(parsed.sessions) ||
      !Array.isArray(parsed.invites) ||
      !Array.isArray(parsed.linkCodes) ||
      !Array.isArray(parsed.transactions) ||
      (parsed.vaults && !Array.isArray(parsed.vaults)) ||
      (parsed.processedTelegramUpdates && !Array.isArray(parsed.processedTelegramUpdates))
    ) {
      throw new Error("Format penyimpanan Autocatat tidak valid.");
    }
    parsed.vaults ||= [];
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    let transactions = [];
    try {
      transactions = JSON.parse(await fs.readFile(LEGACY_FILE, "utf8"));
      if (!Array.isArray(transactions)) throw new Error("Format penyimpanan transaksi lama tidak valid.");
    } catch (legacyError) {
      if (legacyError.code !== "ENOENT") throw legacyError;
    }
    return {
      users: [],
      sessions: [],
      invites: [],
      linkCodes: [],
      processedTelegramUpdates: [],
      transactions,
      vaults: [],
    };
  }
}

async function loadLocalStore() {
  if (process.env.AUTOCATAT_STORE_LOCAL_FALLBACK === "false") {
    return {
      users: [],
      sessions: [],
      invites: [],
      linkCodes: [],
      processedTelegramUpdates: [],
      transactions: [],
      vaults: [],
    };
  }
  return loadStore();
}

async function saveStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, STORE_FILE);
}

async function readStore() {
  const config = firebaseConfig();
  if (!config) return loadStore();
  const result = await firebaseRead(config);
  return result.store || loadLocalStore();
}

function updateStore(operation) {
  const current = mutationQueue.then(async () => {
    const config = firebaseConfig();
    if (!config) {
      const store = await loadStore();
      const result = await operation(store);
      await saveStore(store);
      return result;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const latest = await firebaseRead(config);
      const store = structuredClone(latest.store || await loadLocalStore());
      const result = await operation(store);
      const token = await firebaseAccessToken(config);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      if (latest.etag) headers["if-match"] = latest.etag;
      const response = await fetch(firebaseStoreUrl(config), {
        method: "PUT",
        headers,
        body: JSON.stringify(store),
      });
      if (response.status === 412) continue;
      if (!response.ok) throw await firebaseError(response);
      return result;
    }
    throw new Error("Firebase sedang menerima banyak perubahan. Coba lagi sebentar.");
  });
  mutationQueue = current.catch(() => {});
  return current;
}

async function streamFirebaseChanges(onChange, { signal, onStatus } = {}) {
  const config = firebaseConfig();
  if (!config) return;
  let retryDelay = 1000;
  while (!signal?.aborted) {
    try {
      const token = await firebaseAccessToken(config);
      const response = await fetch(firebaseStoreUrl(config), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!response.ok) throw await firebaseError(response);
      onStatus?.("connected");
      retryDelay = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let delimiter;
        while ((delimiter = pending.search(/\r?\n\r?\n/)) >= 0) {
          const block = pending.slice(0, delimiter);
          pending = pending.slice(delimiter).replace(/^\r?\n\r?\n/, "");
          const eventName = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          if (eventName === "put" || eventName === "patch") onChange();
          if (eventName === "cancel" || eventName === "auth_revoked") {
            throw new Error("Firebase menutup stream realtime. Periksa ulang izin service account.");
          }
        }
      }
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") return;
      console.error("Firebase realtime stream failed:", error.message);
      onStatus?.("reconnecting");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, retryDelay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }
}

module.exports = {
  firebaseKeyFileCandidates,
  readFirebaseCredentialFile,
  readStore,
  streamFirebaseChanges,
  updateStore,
};
