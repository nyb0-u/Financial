const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const directory = path.join(os.tmpdir(), `autocatat-telegram-${process.pid}`);
const environment = [
  "AUTOCATAT_STORE_BACKEND",
  "AUTOCATAT_STORE_FILE",
  "AUTOCATAT_LEGACY_FILE",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_SHEETS_ID",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
];
const previousEnvironment = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
process.env.AUTOCATAT_STORE_BACKEND = "local";
process.env.AUTOCATAT_STORE_FILE = path.join(directory, "store.json");
process.env.AUTOCATAT_LEGACY_FILE = path.join(directory, "legacy.json");
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.GOOGLE_SHEETS_ID = "";
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = "";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "";
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "";

const { handleTelegramUpdate, telegramTransactionKeyboard } = require("../server");
const { readStore, updateStore } = require("../src/store");

test("Telegram transaction actions are owner-scoped and render inline actions", async (t) => {
  await fs.mkdir(directory, { recursive: true });
  const originalFetch = global.fetch;
  const telegramCalls = [];
  global.fetch = async (url, options) => {
    telegramCalls.push({ method: String(url).split("/").pop(), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), { status: 200 });
  };
  t.after(async () => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const transactionId = "123e4567-e89b-42d3-a456-426614174000";
  await updateStore((store) => {
    store.users.push(
      { id: "owner", telegramUserId: "111", active: true, monthlyBudget: 5000000 },
      { id: "other", telegramUserId: "222", active: true, monthlyBudget: 5000000 },
    );
    store.transactions.push({
      id: transactionId,
      userId: "owner",
      type: "expense",
      amount: 25000,
      description: "Makan siang",
      category: "Makanan & Minuman",
      wallet: "Tunai",
      date: "2026-10-24",
    });
  });

  const keyboard = telegramTransactionKeyboard(transactionId);
  assert.equal(keyboard.inline_keyboard[0][0].text, "✏️ Edit");
  assert.equal(keyboard.inline_keyboard[0][1].text, "🗑 Hapus");
  assert.equal(keyboard.inline_keyboard[1][0].text, "📊 Dashboard");

  const callback = (telegramId) => ({
    callback_query: {
      id: `callback-${telegramId}`,
      from: { id: Number(telegramId) },
      data: `tx:d:${transactionId}`,
      message: { message_id: 50, chat: { id: Number(telegramId), type: "private" } },
    },
  });

  await handleTelegramUpdate(callback("222"));
  assert.equal((await readStore()).transactions.length, 1);
  assert.equal(telegramCalls.at(-1).method, "answerCallbackQuery");
  assert.equal(telegramCalls.at(-1).body.show_alert, true);

  await handleTelegramUpdate(callback("111"));
  assert.equal((await readStore()).transactions.length, 0);
  assert.equal(telegramCalls.at(-1).method, "editMessageText");
  assert.match(telegramCalls.at(-1).body.text, /berhasil dihapus/);
});
