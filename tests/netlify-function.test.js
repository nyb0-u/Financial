const test = require("node:test");
const assert = require("node:assert/strict");
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
  const response = await handler(new Request(
    "https://autocatat.netlify.app/api/telegram/webhook",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  ), {});

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Webhook Telegram tidak valid." });
});
