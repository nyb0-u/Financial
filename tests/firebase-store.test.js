const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("Firebase credential lookup falls back from the configured path to the project root and credentials folder", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "autocatat-firebase-keys-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const { firebaseKeyFileCandidates, readFirebaseCredentialFile } = require("../src/store");
  const rootKey = path.join(directory, "firebase-service-account.json");
  const credentialsDirectory = path.join(directory, "credentials");
  const credentialsKey = path.join(credentialsDirectory, "firebase-service-account.json");
  const candidates = firebaseKeyFileCandidates(directory, "credentials/firebase-service-account.json");

  await fs.writeFile(rootKey, "{\"location\":\"root\"}");
  const rootResult = await readFirebaseCredentialFile(candidates);
  assert.equal(rootResult.filePath, rootKey);

  await fs.rm(rootKey);
  await fs.mkdir(credentialsDirectory);
  await fs.writeFile(credentialsKey, "{\"location\":\"credentials\"}");
  const credentialsResult = await readFirebaseCredentialFile(candidates);
  assert.equal(credentialsResult.filePath, credentialsKey);
  assert.deepEqual(candidates, [
    credentialsKey,
    rootKey,
  ]);
});

test("Firebase auth status returns 503 when Realtime Database denies service-account access", async (t) => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const originalFetch = global.fetch;
  const environmentKeys = [
    "AUTOCATAT_STORE_BACKEND",
    "FIREBASE_DATABASE_URL",
    "FIREBASE_SERVICE_ACCOUNT_KEY_FILE",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
  ];
  const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.AUTOCATAT_STORE_BACKEND = "firebase";
  process.env.FIREBASE_DATABASE_URL = "https://autocatat-status-test-default-rtdb.firebaseio.com";
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE = "";
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: "service_account",
    project_id: "autocatat-status-test",
    client_email: "status-test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    private_key_id: `status-test-${crypto.randomUUID()}`,
    token_uri: "https://oauth.test/token",
  });
  global.fetch = async (url, options = {}) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    if (url === "https://oauth.test/token") {
      return new Response(JSON.stringify({ access_token: "status-test-token", expires_in: 3600 }), { status: 200 });
    }
    if (String(url).endsWith("/autocatat.json")) {
      return new Response("Unauthorized request.", { status: 401 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const { createServer } = require("../server");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/status`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /Firebase tidak dapat diakses/);

  const loginResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${server.address().port}`,
    },
    body: JSON.stringify({ email: "admin@example.com", password: "test-password" }),
  });
  const loginBody = await loginResponse.json();
  assert.equal(loginResponse.status, 503);
  assert.match(loginBody.error, /Firebase tidak dapat diakses/);
});

test("Firebase store retries an ETag conflict and persists the latest state", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "autocatat-firebase-"));
  const keyFile = path.join(directory, "service-account.json");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.writeFile(keyFile, JSON.stringify({
    type: "service_account",
    client_email: "autocatat@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    private_key_id: "test-key",
    token_uri: "https://oauth.test/token",
  }));

  const originalFetch = global.fetch;
  const originalEnvironment = {
    AUTOCATAT_STORE_BACKEND: process.env.AUTOCATAT_STORE_BACKEND,
    AUTOCATAT_STORE_LOCAL_FALLBACK: process.env.AUTOCATAT_STORE_LOCAL_FALLBACK,
    AUTOCATAT_STORE_FILE: process.env.AUTOCATAT_STORE_FILE,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
    FIREBASE_SERVICE_ACCOUNT_KEY_FILE: process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  };
  process.env.AUTOCATAT_STORE_BACKEND = "firebase";
  process.env.AUTOCATAT_STORE_LOCAL_FALLBACK = "false";
  process.env.AUTOCATAT_STORE_FILE = path.join(directory, "store.json");
  process.env.FIREBASE_DATABASE_URL = "https://autocatat-test-default-rtdb.firebaseio.com";
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE = "";
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = await fs.readFile(keyFile, "utf8");

  let remoteStore = {
    users: [],
    sessions: [],
    invites: [],
    transactions: [],
  };
  let version = 0;
  let conflict = true;
  let tokenScopes = [];
  global.fetch = async (url, options = {}) => {
    if (url === "https://oauth.test/token") {
      const parameters = new URLSearchParams(options.body);
      const assertion = parameters.get("assertion");
      tokenScopes = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()).scope.split(" ");
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (String(url).endsWith("/autocatat.json") && options.method === "PUT") {
      if (conflict) {
        conflict = false;
        return new Response("", { status: 412 });
      }
      remoteStore = JSON.parse(options.body);
      version += 1;
      return new Response("null", { status: 200 });
    }
    if (String(url).endsWith("/autocatat.json")) {
      return new Response(JSON.stringify(remoteStore), {
        status: 200,
        headers: { ETag: `"v${version}"` },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  t.after(async () => {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { updateStore } = require("../src/store");
  let attempts = 0;
  await updateStore((store) => {
    attempts += 1;
    store.transactions.push({ id: "transaction-1", userId: "user-1" });
    store.linkCodes = store.linkCodes.filter((item) => item.expiresAt > Date.now());
    store.processedTelegramUpdates = store.processedTelegramUpdates.filter(Boolean);
  });

  assert.equal(attempts, 2);
  assert.equal(remoteStore.transactions.length, 1);
  assert.equal(remoteStore.transactions[0].userId, "user-1");
  assert.deepEqual(remoteStore.linkCodes, []);
  assert.deepEqual(remoteStore.processedTelegramUpdates, []);
  assert.deepEqual(tokenScopes, [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/firebase.database",
  ]);

  global.fetch = async (url, options = {}) => {
    if (options.headers?.Accept === "text/event-stream") {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: put\ndata: {\"path\":\"/\",\"data\":{}}\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    return originalFetch(url, options);
  };
  const controller = new AbortController();
  let changes = 0;
  const { streamFirebaseChanges } = require("../src/store");
  await streamFirebaseChanges(() => {
    changes += 1;
    controller.abort();
  }, { signal: controller.signal });
  assert.equal(changes, 1);
});
