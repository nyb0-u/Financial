const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = "autocatat_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw Object.assign(new Error("Kata sandi harus 12–128 karakter."), { status: 400 });
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [scheme, saltHex, hashHex] = encoded.split("$");
  if (scheme !== "scrypt" || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) {
    return false;
  }
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return safeEqual(derived.toString("hex"), hashHex);
}

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function createSession(userId) {
  const token = createToken();
  const csrfToken = createToken(24);
  return {
    token,
    session: {
      tokenHash: hashToken(token),
      csrfToken,
      userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    },
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return ["", ""];
      const key = part.slice(0, index).trim();
      try {
        return [key, decodeURIComponent(part.slice(index + 1).trim())];
      } catch {
        return [key, ""];
      }
    }).filter(([key]) => key),
  );
}

function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    monthlyBudget: user.monthlyBudget,
    telegramLinked: Boolean(user.telegramUserId),
    createdAt: user.createdAt,
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearSessionCookie,
  createSession,
  createToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  parseCookies,
  publicUser,
  safeEqual,
  sessionCookie,
  verifyPassword,
};
