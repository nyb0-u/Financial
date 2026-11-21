const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const testDirectory = path.join(os.tmpdir(), `autocatat-netlify-${process.pid}`);
process.env.AUTOCATAT_STORE_FILE = path.join(testDirectory, "store.json");
process.env.AUTOCATAT_STORE_LOCAL_FALLBACK = "false";
process.env.AUTOCATAT_STORE_BACKEND = "local";
process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE = "";
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "";
process.env.ADMIN_SETUP_KEY = "test-netlify-admin-key";
process.env.COOKIE_SECURE = "true";
process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

let handler;
test.before(async () => {
  ({ default: handler } = await import("../netlify/functions/api.mjs"));
});

test.after(async () => {
  await fs.rm(testDirectory, { recursive: true, force: true });
});

test("Netlify function routes API requests to the existing auth handler", async () => {
  const response = await handler(
    new Request("https://autocatat.netlify.app/api/auth/status"),
    { ip: "203.0.113.10" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    hasUsers: false,
    setupEnabled: true,
    registrationEnabled: false,
  });
});

test("Netlify function preserves API request bodies, origin checks, and secure cookies", async () => {
  const url = "https://autocatat.netlify.app/api/auth/setup";
  const response = await handler(new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://autocatat.netlify.app",
    },
    body: JSON.stringify({
      setupKey: process.env.ADMIN_SETUP_KEY,
      password: "correct horse battery staple",
    }),
  }), { ip: "203.0.113.10" });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("set-cookie").includes("Secure"), true);
  const body = await response.json();
  assert.equal(body.user.role, "admin");
  assert.ok(body.csrfToken);

  const configResponse = await handler(new Request("https://autocatat.netlify.app/api/config", {
    headers: { Cookie: response.headers.get("set-cookie").split(";")[0] },
  }), { ip: "203.0.113.10" });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.realtime, false);
});

test("Netlify Telegram webhook rejects requests with an invalid secret", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await handler(new Request(
      "https://autocatat.netlify.app/api/telegram/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    ), {});
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Webhook Telegram tidak valid.",
    detail: "Header X-Telegram-Bot-Api-Secret-Token tidak cocok dengan TELEGRAM_WEBHOOK_SECRET.",
  });
  assert.match(JSON.stringify(warnings), /headerPresent/);
  assert.equal(JSON.stringify(warnings).includes(process.env.TELEGRAM_WEBHOOK_SECRET), false);
});

test("Netlify webhook awaits Firebase link persistence and Telegram /link reply", async () => {
  const code = "QWERTYuiopASDFGHjklZXCVB";
  const userId = "telegram-link-user";
  const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const environmentKeys = [
    "AUTOCATAT_STORE_BACKEND",
    "AUTOCATAT_STORE_LOCAL_FALLBACK",
    "FIREBASE_DATABASE_URL",
    "FIREBASE_SERVICE_ACCOUNT_KEY_FILE",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
  ];
  const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let firebaseStore = {
    users: [{ id: userId, username: "link-user", active: true, telegramUserId: null }],
    sessions: [],
    invites: [],
    linkCodes: [{
      tokenHash: crypto.createHash("sha256").update(code).digest("hex"),
      userId,
      expiresAt: Date.now() + 60_000,
      usedAt: null,
    }],
    transactions: [],
    processedTelegramUpdates: [],
    vaults: [],
  };
  const databaseUrl = "https://telegram-link-test-default-rtdb.firebaseio.com/autocatat.json";
  process.env.AUTOCATAT_STORE_BACKEND = "firebase";
  process.env.AUTOCATAT_STORE_LOCAL_FALLBACK = "false";
  process.env.FIREBASE_DATABASE_URL = "https://telegram-link-test-default-rtdb.firebaseio.com";
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE = "";
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: "service_account",
    client_email: "telegram-link-test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    private_key_id: crypto.randomUUID(),
    token_uri: "https://oauth.telegram-link-test/token",
  });
  process.env.TELEGRAM_WEBHOOK_SECRET = " \ttest-webhook-secret \n";

  let notifyFetchStarted;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => { notifyFetchStarted = resolve; });
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  global.fetch = async (url, options) => {
    if (url === "https://oauth.telegram-link-test/token") {
      return new Response(JSON.stringify({ access_token: "telegram-link-test-access-token", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (String(url) === databaseUrl && options.method === "PUT") {
      assert.equal(options.headers["if-match"], '"firebase-test-v1"');
      firebaseStore = JSON.parse(options.body);
      return new Response("null", { status: 200 });
    }
    if (String(url) === databaseUrl) {
      return new Response(JSON.stringify(firebaseStore), {
        status: 200,
        headers: { ETag: '"firebase-test-v1"' },
      });
    }
    if (String(url).endsWith("/sendMessage")) {
      assert.match(String(url), /api\.telegram\.org\/bottest-telegram-token\/sendMessage$/);
      const body = JSON.parse(options.body);
      assert.equal(body.chat_id, 456);
      notifyFetchStarted();
      await fetchGate;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  let completed = false;
  let response;
  try {
    const responsePromise = handler(new Request(
      "https://autocatat.netlify.app/api/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
        },
        body: JSON.stringify({
          update_id: 1024,
          message: {
            chat: { id: 456, type: "private" },
            from: { id: 789 },
            text: `/link ${code}`,
          },
        }),
      },
    ), {}).then((result) => {
      completed = true;
      return result;
    });

    let timeout;
    const sendStarted = await Promise.race([
      fetchStarted.then(() => true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); }),
    ]);
    clearTimeout(timeout);
    assert.equal(sendStarted, true, "the /link handler should call Telegram sendMessage");

    assert.equal(firebaseStore.users[0].telegramUserId, "789", "Firebase persistence should finish before sendMessage");
    assert.ok(firebaseStore.linkCodes[0].usedAt);
    assert.equal(completed, false, "the webhook must wait for Telegram sendMessage to finish");
    assert.match(JSON.stringify(warnings), /leading or trailing whitespace/);

    releaseFetch();
    response = await responsePromise;
  } finally {
    releaseFetch();
    global.fetch = originalFetch;
    console.warn = originalWarn;
    process.env.TELEGRAM_WEBHOOK_SECRET = originalSecret;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("Netlify webhook logs Firebase /link and Telegram sendMessage failures", async () => {
  const environmentKeys = [
    "AUTOCATAT_STORE_BACKEND",
    "FIREBASE_DATABASE_URL",
    "TELEGRAM_WEBHOOK_SECRET",
  ];
  const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const originalError = console.error;
  const errors = [];
  process.env.AUTOCATAT_STORE_BACKEND = "firebase";
  process.env.FIREBASE_DATABASE_URL = "not-a-firebase-url";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
  global.fetch = async () => new Response(JSON.stringify({
    ok: false,
    description: "Forbidden: bot was blocked by the user",
  }), { status: 403 });
  console.error = (...args) => errors.push(args);

  let response;
  try {
    response = await handler(new Request(
      "https://autocatat.netlify.app/api/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
        },
        body: JSON.stringify({
          update_id: 2048,
          message: {
            chat: { id: 456, type: "private" },
            from: { id: 789 },
            text: "/link QWERTYuiopASDFGHjklZXCVB",
          },
        }),
      },
    ), {});
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Update Telegram gagal diproses.",
    updateId: 2048,
  });
  const log = JSON.stringify(errors);
  assert.match(log, /Telegram \/link processing failed/);
  assert.match(log, /Telegram \/link failure reply failed/);
  assert.match(log, /Telegram webhook update processing failed/);
  assert.match(log, /"updateId":2048/);
  assert.match(log, /Forbidden: bot was blocked by the user/);
});
