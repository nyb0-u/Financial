const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadGoogleCredentials } = require("../server");

const credentialsDirectory = path.join(os.tmpdir(), `autocatat-google-credentials-${process.pid}`);

test("loads and validates a Google service account JSON key", async (t) => {
  await fs.mkdir(credentialsDirectory, { recursive: true });
  const keyFile = path.join(credentialsDirectory, "service-account.json");
  await fs.writeFile(keyFile, JSON.stringify({
    type: "service_account",
    client_email: "autocatat@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n",
  }));
  t.after(async () => fs.rm(credentialsDirectory, { recursive: true, force: true }));

  const result = await loadGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: keyFile });
  assert.equal(result.email, "autocatat@example.iam.gserviceaccount.com");
  assert.match(result.privateKey, /BEGIN PRIVATE KEY/);
});

test("preserves the existing email and private key environment configuration", async () => {
  const result = await loadGoogleCredentials({
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "autocatat@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n",
  });
  assert.equal(result.email, "autocatat@example.iam.gserviceaccount.com");
});

test("falls back to the configured email and private key when the JSON file is missing", async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  t.after(() => {
    console.warn = originalWarn;
  });

  const result = await loadGoogleCredentials({
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path.join(credentialsDirectory, "missing-service-account.json"),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "autocatat@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n",
  });
  assert.equal(result.email, "autocatat@example.iam.gserviceaccount.com");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /falling back/);
});

test("loads Google service account credentials from a JSON environment secret", async () => {
  const result = await loadGoogleCredentials({
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: "service_account",
      client_email: "autocatat@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n",
    }),
  });
  assert.equal(result.email, "autocatat@example.iam.gserviceaccount.com");
  assert.match(result.privateKey, /BEGIN PRIVATE KEY/);
});

test("reports missing, malformed, and non-service-account key files", async (t) => {
  await fs.mkdir(credentialsDirectory, { recursive: true });
  const malformed = path.join(credentialsDirectory, "malformed.json");
  const wrongType = path.join(credentialsDirectory, "wrong-type.json");
  await fs.writeFile(malformed, "{");
  await fs.writeFile(wrongType, JSON.stringify({ type: "authorized_user" }));
  t.after(async () => fs.rm(credentialsDirectory, { recursive: true, force: true }));

  await assert.rejects(
    loadGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path.join(credentialsDirectory, "missing.json") }),
    /tidak ditemukan/,
  );
  await assert.rejects(
    loadGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: malformed }),
    /bukan JSON yang valid/,
  );
  await assert.rejects(
    loadGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: wrongType }),
    /type service_account/,
  );
  await assert.rejects(
    loadGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: "{" }),
    /GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON yang valid/,
  );
});
