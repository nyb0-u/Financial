const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const testDirectory = path.join(os.tmpdir(), `autocatat-tests-${process.pid}`);
process.env.AUTOCATAT_STORE_FILE = path.join(testDirectory, "store.json");
process.env.AUTOCATAT_LEGACY_FILE = path.join(testDirectory, "legacy-transactions.json");
process.env.AUTOCATAT_STORE_BACKEND = "local";
process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE = "";
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "";
process.env.ADMIN_SETUP_KEY = "test-admin-setup-secret";
process.env.MONTHLY_BUDGET = "5000000";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.GOOGLE_SHEETS_ID = "";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "";
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "";
const { createServer, handleTelegramUpdate } = require("../server");

let server;
let baseUrl;
let admin;
let member;
let memberCookie;
let memberCsrf;
let transactionId;

async function request(pathname, { cookie, csrf, ...options } = {}) {
  const headers = new Headers(options.headers);
  if (baseUrl && options.method && options.method !== "GET" && !headers.has("Origin")) headers.set("Origin", baseUrl);
  if (cookie) headers.set("Cookie", cookie);
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  return { response, body: await response.json() };
}

function sessionCookie(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

test("accounts, sessions, and finance data are isolated by user", async (t) => {
  await fs.mkdir(testDirectory, { recursive: true });
  await fs.writeFile(
    path.join(testDirectory, "legacy-transactions.json"),
    JSON.stringify([{
      id: "legacy-transaction",
      amount: 8_000,
      type: "expense",
      description: "Transaksi lama",
      category: "Lainnya",
      wallet: "Tunai",
      date: "2026-10-20",
    }]),
  );
  server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(testDirectory, { recursive: true, force: true });
  });

  const status = await request("/api/auth/status");
  assert.deepEqual(status.body, { hasUsers: false, setupEnabled: true, registrationEnabled: false });
  const unauthenticated = await request("/api/transactions?month=2026-10");
  assert.equal(unauthenticated.response.status, 401);
  const unauthenticatedVault = await request("/api/vault");
  assert.equal(unauthenticatedVault.response.status, 401);
  const prematureRegistration = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "member",
      email: "member@example.com",
      password: "another correct horse",
    }),
  });
  assert.equal(prematureRegistration.response.status, 403);

  const setup = await request("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupKey: process.env.ADMIN_SETUP_KEY,
      email: "admin@example.com",
      password: "correct horse battery staple",
    }),
  });
  assert.equal(setup.response.status, 201);
  admin = { cookie: sessionCookie(setup.response), csrf: setup.body.csrfToken, user: setup.body.user };
  assert.equal(admin.user.role, "admin");
  assert.equal(admin.user.username, "BOOPAW");
  assert.equal(admin.user.email, "amjadamrullah911@gmail.com");
  const { updateStore } = require("../src/store");
  await updateStore((store) => {
    delete store.users.find((item) => item.id === admin.user.id).username;
  });
  const migratedStatus = await request("/api/auth/status");
  assert.equal(migratedStatus.response.status, 200);
  const migratedAdmin = JSON.parse(await fs.readFile(path.join(testDirectory, "store.json"), "utf8"))
    .users.find((item) => item.id === admin.user.id);
  assert.equal(migratedAdmin.username, "BOOPAW");
  const emptyVault = await request("/api/vault", { cookie: admin.cookie });
  assert.equal(emptyVault.response.status, 200);
  assert.equal(emptyVault.body.vault, null);
  const invalidVault = await request("/api/vault", {
    method: "PUT",
    cookie: admin.cookie,
    csrf: admin.csrf,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ salt: "invalid", iv: "invalid", ciphertext: "invalid", expectedUpdatedAt: null }),
  });
  assert.equal(invalidVault.response.status, 400);
  const encryptedVault = { salt: "A".repeat(22), iv: "A".repeat(16), ciphertext: "A".repeat(22), expectedUpdatedAt: null };
  const savedVault = await request("/api/vault", {
    method: "PUT",
    cookie: admin.cookie,
    csrf: admin.csrf,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(encryptedVault),
  });
  assert.equal(savedVault.response.status, 200);
  const staleVaultSave = await request("/api/vault", {
    method: "PUT",
    cookie: admin.cookie,
    csrf: admin.csrf,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(encryptedVault),
  });
  assert.equal(staleVaultSave.response.status, 409);

  const replaySetup = await request("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupKey: process.env.ADMIN_SETUP_KEY,
      email: "attacker@example.com",
      password: "correct horse battery staple",
    }),
  });
  assert.equal(replaySetup.response.status, 409);

  const created = await request("/api/transactions", {
    method: "POST",
    cookie: admin.cookie,
    csrf: admin.csrf,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: 35_000,
      type: "expense",
      description: "Transaksi admin",
      category: "Makanan & Minuman",
      wallet: "Tunai",
      date: "2026-10-24",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.transaction.userId);

  const missingCsrf = await request("/api/transactions", {
    method: "POST",
    cookie: admin.cookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: 1_000,
      type: "expense",
      description: "CSRF test",
      category: "Lainnya",
      wallet: "Tunai",
      date: "2026-10-24",
    }),
  });
  assert.equal(missingCsrf.response.status, 403);

  const registration = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "member",
      email: "member@example.com",
      password: "another correct horse",
    }),
  });
  assert.equal(registration.response.status, 201);
  member = registration.body.user;
  assert.equal(member.role, "user");
  assert.equal(member.username, "member");
  memberCookie = sessionCookie(registration.response);
  memberCsrf = registration.body.csrfToken;
  const reservedUsername = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "ADMIN",
      email: "reserved@example.com",
      password: "another correct horse",
    }),
  });
  assert.equal(reservedUsername.response.status, 400);
  const duplicateUsername = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "MEMBER",
      email: "second-member@example.com",
      password: "another correct horse",
    }),
  });
  assert.equal(duplicateUsername.response.status, 409);
  const memberVault = await request("/api/vault", { cookie: memberCookie });
  assert.equal(memberVault.response.status, 200);
  assert.equal(memberVault.body.vault, null);

  const memberSummary = await request("/api/summary?month=2026-10", { cookie: memberCookie });
  assert.equal(memberSummary.response.status, 200);
  assert.equal(memberSummary.body.expenses, 0);
  assert.equal(memberSummary.body.balance, 0);

  const memberCreate = await request("/api/transactions", {
    method: "POST",
    cookie: memberCookie,
    csrf: memberCsrf,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: 12_000,
      type: "expense",
      description: "Transaksi anggota",
      category: "Belanja",
      wallet: "Tunai",
      date: "2026-10-24",
    }),
  });
  assert.equal(memberCreate.response.status, 201);
  transactionId = memberCreate.body.transaction.id;

  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  const link = await request("/api/telegram/link-code", {
    method: "POST",
    cookie: memberCookie,
    csrf: memberCsrf,
  });
  assert.equal(link.response.status, 201);
  let telegramMessages = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, options) => {
    telegramMessages.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }));
  };
  try {
    await handleTelegramUpdate({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456 },
        text: `/link ${link.body.code}`,
      },
    });
    const telegramExpense = {
      update_id: 1001,
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456 },
        text: "kopi 18rb",
      },
    };
    await handleTelegramUpdate(telegramExpense);
    await handleTelegramUpdate(telegramExpense);
  } finally {
    global.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
  assert.match(telegramMessages[0].text, /berhasil ditautkan/);
  assert.match(telegramMessages[1].text, /Rp18\.000/);
  assert.match(telegramMessages[2].text, /sudah pernah diproses/);
  const linkedAccount = await request("/api/account", { cookie: memberCookie });
  assert.equal(linkedAccount.body.telegramLinked, true);

  const crossAccountDelete = await request(`/api/transactions/${created.body.transaction.id}`, {
    method: "DELETE",
    cookie: memberCookie,
    csrf: memberCsrf,
  });
  assert.equal(crossAccountDelete.response.status, 404);

  const adminUsers = await request("/api/admin/users", { cookie: admin.cookie });
  assert.equal(adminUsers.response.status, 200);
  assert.equal(adminUsers.body.users.length, 2);

  const memberAdminAccess = await request("/api/admin/users", { cookie: memberCookie });
  assert.equal(memberAdminAccess.response.status, 403);

  const logout = await request("/api/auth/logout", {
    method: "POST",
    cookie: memberCookie,
    csrf: memberCsrf,
  });
  assert.equal(logout.response.status, 200);
  const revokedSession = await request("/api/summary?month=2026-10", { cookie: memberCookie });
  assert.equal(revokedSession.response.status, 401);

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "MeMbEr", password: "another correct horse" }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.id, member.id);
  const emailLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "member@example.com", password: "another correct horse" }),
  });
  assert.equal(emailLogin.response.status, 401);

  const disableMember = await request(`/api/admin/users/${member.id}`, {
    method: "DELETE",
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(disableMember.response.status, 200);
  const disabledLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "member", password: "another correct horse" }),
  });
  assert.equal(disabledLogin.response.status, 401);

  const migratedStore = JSON.parse(await fs.readFile(path.join(testDirectory, "store.json"), "utf8"));
  assert.equal(migratedStore.transactions.length, 4);
  assert.equal(migratedStore.transactions.filter((item) => item.userId === admin.user.id).length, 2);
  assert.equal(migratedStore.transactions.filter((item) => item.userId === member.id).length, 2);
  assert.ok(migratedStore.transactions.some((item) => item.id === "legacy-transaction" && item.userId === admin.user.id));
  assert.ok(transactionId);
});
