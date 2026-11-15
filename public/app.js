const state = {
  month: manilaToday().slice(0, 7),
  currency: "IDR",
  transactions: [],
  summary: null,
  config: null,
  view: "overview",
  balanceHidden: false,
  user: null,
  csrfToken: "",
  authStatus: null,
  account: null,
  firebaseEvents: null,
  realtimeRefreshTimer: null,
  realtimePollingTimer: null,
  vaultRecord: null,
  vaultSalt: null,
  vaultKey: null,
  vaultEntries: [],
  revealedCredentials: new Set(),
  vaultLockTimer: null,
  generatedVaultKey: "",
};

const $ = (selector) => document.querySelector(selector);
const VAULT_KDF_ITERATIONS = 310_000;
function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const money = (amount, currency = "IDR") => {
  const symbols = { IDR: "Rp", USD: "$", PHP: "₱" };
  const value = Number(amount) || 0;
  return `${value < 0 ? "−" : ""}${symbols[currency] || symbols.IDR}${Math.abs(value).toLocaleString(currency === "IDR" ? "id-ID" : "en-US", {
    maximumFractionDigits: currency === "IDR" ? 0 : 2,
  })}`;
};
const monthName = (month) => new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Manila" }).format(new Date(`${month}-01T12:00:00+08:00`));
const dateLabel = (date) => new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00+08:00`));
const categoryIcons = {
  "Makanan & Minuman": "☕",
  Transportasi: "↗",
  Belanja: "◇",
  "Kebutuhan Rumah Tangga": "⌂",
  Tagihan: "▤",
  Kesehatan: "✚",
  Hiburan: "♫",
  Pendidikan: "▣",
  Pemasukan: "↙",
  Lainnya: "✳",
};

async function api(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (method !== "GET" && state.csrfToken && !headers["X-CSRF-Token"]) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && state.user) {
    lockVault();
    state.firebaseEvents?.close();
    state.firebaseEvents = null;
    clearInterval(state.realtimePollingTimer);
    state.realtimePollingTimer = null;
    state.user = null;
    state.csrfToken = "";
    showAuthScreen("login");
  }
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}

async function refresh() {
  const [summary, transactions, config] = await Promise.all([
    api(`/api/summary?month=${encodeURIComponent(state.month)}`),
    api(`/api/transactions?month=${encodeURIComponent(state.month)}`),
    api("/api/config"),
  ]);
  state.summary = summary;
  state.transactions = transactions.transactions;
  state.config = config;
  state.user = config.user;
  renderProfile();
  render();
  connectFirebaseEvents();
}

function connectFirebaseEvents() {
  if (!state.config?.firebase) {
    state.firebaseEvents?.close();
    state.firebaseEvents = null;
    clearInterval(state.realtimePollingTimer);
    state.realtimePollingTimer = null;
    setFirebaseStatus("Penyimpanan lokal", false);
    return;
  }
  if (state.config.realtime === false) {
    state.firebaseEvents?.close();
    state.firebaseEvents = null;
    if (!state.realtimePollingTimer) {
      setFirebaseStatus("Sinkronisasi tiap 30 detik", true);
      state.realtimePollingTimer = setInterval(() => {
        refresh().catch((error) => toast(error.message));
      }, 30_000);
    }
    return;
  }
  clearInterval(state.realtimePollingTimer);
  state.realtimePollingTimer = null;
  if (state.firebaseEvents) return;
  const events = new EventSource("/api/events");
  state.firebaseEvents = events;
  events.addEventListener("firebase-status", (event) => {
    const connected = JSON.parse(event.data) === "connected";
    setFirebaseStatus(connected ? "Realtime aktif" : "Menyambungkan ulang…", connected);
  });
  events.addEventListener("refresh", () => {
    clearTimeout(state.realtimeRefreshTimer);
    state.realtimeRefreshTimer = setTimeout(() => {
      refresh().catch((error) => toast(error.message));
    }, 200);
  });
  events.onerror = () => {
    setFirebaseStatus("Menyambungkan ulang…", false);
  };
}

function setFirebaseStatus(label, connected) {
  $("#firebase-status").textContent = label;
  $("#firebase-dot").classList.toggle("connected", connected);
  const button = $("#firebase-connection");
  const description = `Firebase: ${label}. Backend penyimpanan dan sinkronisasi realtime; konfigurasi dilakukan oleh administrator server.`;
  button.setAttribute("aria-label", description);
  button.title = description;
}

function showAuthScreen(mode) {
  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  $("#auth-error").classList.add("hidden");
  $("#auth-switch").classList.add("hidden");
  ["setup-form", "login-form", "register-form"].forEach((id) => $(`#${id}`).classList.add("hidden"));
  if (mode === "setup") {
    $("#auth-title").textContent = "Buat akun admin";
    $("#auth-description").textContent = "Selesaikan setup pertama menggunakan kunci admin rahasia dari file .env.";
    $(".auth-security").textContent = "Kunci setup hanya digunakan untuk membuat akun admin pertama.";
    $("#setup-form").classList.remove("hidden");
  } else if (mode === "register") {
    $("#auth-title").textContent = "Buat akun baru";
    $("#auth-description").textContent = "Daftar dengan email dan kata sandi untuk mulai mencatat keuangan.";
    $(".auth-security").textContent = "Tidak perlu kode undangan. Data setiap akun tersimpan terpisah dan privat.";
    $("#register-form").classList.remove("hidden");
    $("#auth-switch").textContent = "Sudah punya akun? Masuk";
    $("#auth-switch").classList.remove("hidden");
  } else if (mode === "unavailable") {
    $("#auth-title").textContent = "Setup admin belum siap";
    $("#auth-description").textContent = "Atur ADMIN_SETUP_KEY di file .env, lalu mulai ulang Autocatat untuk membuat akun pertama.";
    $(".auth-security").textContent = "Kunci setup hanya digunakan untuk membuat akun admin pertama.";
  } else if (mode === "service-error") {
    $("#auth-title").textContent = "Status akun tidak tersedia";
    $("#auth-description").textContent = "Server belum dapat membaca penyimpanan. Periksa koneksi Firebase dan log server.";
    $(".auth-security").textContent = "Tidak ada akun yang dibuat atau diubah.";
  } else {
    $("#auth-title").textContent = "Masuk ke Autocatat";
    $("#auth-description").textContent = "Kelola keuangan pribadimu dengan aman.";
    $(".auth-security").textContent = "Belum punya akun? Daftar gratis tanpa kode undangan.";
    $("#login-form").classList.remove("hidden");
    if (state.authStatus?.hasUsers) {
      $("#auth-switch").textContent = "Belum punya akun? Buat akun";
      $("#auth-switch").classList.remove("hidden");
    }
  }
}

function renderProfile() {
  const email = state.user?.email || "Keuangan pribadi";
  $("#profile-email").innerHTML = `${escapeHtml(email)}<small>${state.user?.role === "admin" ? "Administrator" : "Akun pribadi"}</small>`;
  $("#profile-avatar").textContent = email.slice(0, 1).toUpperCase();
}

function showAuthenticatedApp() {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  renderProfile();
}

async function completeAuth(result) {
  state.user = result.user;
  state.csrfToken = result.csrfToken;
  showAuthenticatedApp();
  await refresh();
  toast(`Berhasil masuk sebagai ${result.user.email}.`);
}

async function loadAccountSettings() {
  const account = await api("/api/account");
  state.account = account;
  $("#budget-form").elements.monthlyBudget.value = account.monthlyBudget;
  $("#telegram-account-status").textContent = account.telegramLinked
    ? "Telegram sudah tertaut ke akun ini."
    : state.config?.telegram
      ? "Belum tertaut. Buat kode lalu kirim perintahnya ke bot."
      : "Bot Telegram belum dikonfigurasi server.";
  $("#link-telegram-button").classList.toggle("hidden", account.telegramLinked || !state.config?.telegram);
  $("#unlink-telegram-button").classList.toggle("hidden", !account.telegramLinked);
  $("#sheets-account-status").textContent = account.sheet.spreadsheet
    ? `Konfigurasi spreadsheet tersedia (tab ${account.sheet.tab}).`
    : "Google Sheets belum dikonfigurasi di server.";
  const isAdmin = account.user.role === "admin";
  document.querySelectorAll(".admin-settings").forEach((element) => element.classList.toggle("hidden", !isAdmin));
  if (isAdmin) await loadAdminUsers();
}

async function loadAdminUsers() {
  const result = await api("/api/admin/users");
  $("#user-list").innerHTML = result.users.map((user) => `
    <div class="managed-user">
      <span><b>${escapeHtml(user.email)}</b><small>${user.role === "admin" ? "Admin" : "Pengguna"} · ${user.active ? "Aktif" : "Nonaktif"} · Telegram ${user.telegramLinked ? "tertaut" : "belum tertaut"}</small></span>
      ${user.active && user.id !== state.user.id ? `<button type="button" data-disable-user="${user.id}" aria-label="Nonaktifkan ${escapeHtml(user.email)}">Nonaktifkan</button>` : ""}
    </div>`).join("") || '<div class="settings-note">Belum ada akun.</div>';
}

function setConnectionStatus(name, connected) {
  const status = $(`#${name}-status`);
  const dot = $(`#${name}-dot`);
  status.textContent = connected ? "Konfigurasi tersedia" : "Belum dikonfigurasi";
  dot.classList.toggle("connected", connected);
  const button = status.closest("button");
  if (button) {
    const service = name === "sheets" ? "Google Sheets" : "Telegram";
    button.setAttribute("aria-label", `${service}: ${status.textContent}. Klik untuk status dan pengaturan.`);
    button.title = `${service}: ${status.textContent}. Klik untuk status dan pengaturan.`;
  }
}

function renderSummary() {
  const summary = state.summary.byCurrency[state.currency];
  $("#balance-value").textContent = state.balanceHidden ? "••••••••" : money(summary.balance, state.currency);
  $("#income-value").textContent = money(summary.income, state.currency);
  $("#expenses-value").textContent = money(summary.expenses, state.currency);
  $("#budget-value").textContent = state.currency === "IDR" ? money(summary.budgetRemaining, state.currency) : "—";
  $("#income-count").textContent = `${state.transactions.filter(({ type, currency }) => type === "income" && (currency || "IDR") === state.currency).length} transaksi`;
  $("#expense-count").textContent = `${state.transactions.filter(({ type, currency }) => type === "expense" && (currency || "IDR") === state.currency).length} transaksi`;
  $("#budget-caption").textContent = state.currency === "IDR" ? `Terpakai ${money(summary.expenses, state.currency)}` : "Anggaran hanya dihitung dalam IDR";
  $("#budget-percent").textContent = state.currency === "IDR" ? `${summary.budgetUsedPercent}%` : "—";
  $("#budget-bar").style.width = `${state.currency === "IDR" ? summary.budgetUsedPercent : 0}%`;
  $("#daily-date").textContent = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(new Date(`${manilaToday()}T12:00:00+08:00`));
  $("#today-income").textContent = money(summary.todayIncome, state.currency);
  $("#today-expenses").textContent = money(summary.todayExpenses, state.currency);
  $("#today-count").textContent = String(summary.todayTransactionCount);
  $("#chart-month").textContent = monthName(state.month).toUpperCase();
  setConnectionStatus("telegram", state.config.telegram);
  setConnectionStatus("sheets", state.config.sheets);
  renderChart();
  renderCategories();
  renderWallets();
  renderTransactions();
  renderReport();
}

function renderChart() {
  const summary = state.summary;
  const chart = $("#chart-area");
  const [year, month] = state.month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = Array.from({ length: Math.ceil(daysInMonth / 6) }, (_, index) => ({
    label: `${index * 6 + 1}–${Math.min((index + 1) * 6, daysInMonth)}`,
    start: index * 6 + 1,
    end: Math.min((index + 1) * 6, daysInMonth),
    income: 0,
    expense: 0,
  }));
  state.transactions.forEach((transaction) => {
    if ((transaction.currency || "IDR") !== state.currency) return;
    const dayNumber = Number(transaction.date.slice(-2));
    const day = days[Math.floor((dayNumber - 1) / 6)];
    if (day) day[transaction.type] += transaction.amount;
  });
  const max = Math.max(1, ...days.flatMap(({ income, expense }) => [income, expense]));
  chart.innerHTML = days.map((day) => `
    <div class="chart-day">
      <div class="chart-bars" aria-label="Tanggal ${day.start} sampai ${day.end}: pemasukan ${money(day.income)}, pengeluaran ${money(day.expense)}">
        <i class="chart-bar income" style="height:${Math.max(day.income ? 5 : 2, Math.round(day.income / max * 86))}%" title="Pemasukan ${money(day.income)}"></i>
        <i class="chart-bar expense" style="height:${Math.max(day.expense ? 5 : 2, Math.round(day.expense / max * 86))}%" title="Pengeluaran ${money(day.expense)}"></i>
      </div><span class="chart-day-label">${day.label}</span>
    </div>`).join("");
}

function renderCategories() {
  const entries = Object.entries(state.summary.byCurrency[state.currency].byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const container = $("#category-list");
  if (!entries.length) {
    container.innerHTML = '<div class="category-empty">Belum ada pengeluaran bulan ini.</div>';
    return;
  }
  const max = entries[0][1];
  container.innerHTML = entries.map(([category, amount]) => `
    <div class="category-row">
      <span class="category-icon">${categoryIcons[category] || "✳"}</span>
      <span class="category-name">${escapeHtml(category)}</span><span class="category-total">${money(amount, state.currency)}</span>
      <span class="category-track"><i style="width:${Math.max(5, Math.round(amount / max * 100))}%"></i></span>
    </div>`).join("");
}

function renderWallets() {
  const wallets = Object.entries(state.summary.byCurrency[state.currency].byWallet);
  $("#wallet-count").textContent = `${wallets.length} DOMPET`;
  const symbols = { Tunai: "◈", Rekening: "▣", "E-Wallet": "▤", "Kartu Kredit": "▱" };
  $("#wallet-list").innerHTML = wallets.length
    ? wallets.map(([name, amount]) => `<div class="wallet-card"><div class="wallet-name"><span class="wallet-symbol">${symbols[name] || "◈"}</span>${escapeHtml(name)}</div><div class="wallet-balance">${money(amount, state.currency)}</div></div>`).join("")
    : '<div class="category-empty">Saldo dompet akan muncul setelah transaksi dicatat.</div>';
}

function renderTransactions() {
  const transactions = state.transactions.filter((item) => (item.currency || "IDR") === state.currency);
  const isHistory = state.view === "history";
  $("#transactions-title").textContent = isHistory ? "Riwayat transaksi" : "Transaksi terbaru";
  const rows = isHistory ? transactions : transactions.slice(0, 5);
  $("#transaction-rows").innerHTML = rows.map((transaction) => `
    <tr>
      <td><div class="transaction-name"><span class="transaction-symbol">${categoryIcons[transaction.category] || "✳"}</span><span>${escapeHtml(transaction.description)}<small class="transaction-type">${transaction.type === "income" ? "Pemasukan" : "Pengeluaran"}</small></span></div></td>
      <td><span class="category-tag">${escapeHtml(transaction.category)}</span></td><td>${dateLabel(transaction.date)}</td>
      <td><span class="wallet-tag">${escapeHtml(transaction.wallet)}</span></td>
      <td class="amount-column ${transaction.type === "income" ? "income-amount" : ""}">${transaction.type === "income" ? "+" : "−"}${money(transaction.amount, transaction.currency || "IDR")}</td>
      <td><span class="row-actions"><button data-edit="${transaction.id}" aria-label="Edit transaksi">✎</button><button data-delete="${transaction.id}" aria-label="Hapus transaksi">×</button></span></td>
    </tr>`).join("");
  $("#empty-state").classList.toggle("hidden", transactions.length !== 0);
  $(".table-wrap").classList.toggle("hidden", rows.length === 0);
  $(".transactions-panel .panel-heading").classList.toggle("hidden", transactions.length === 0 && !isHistory);
}

function renderReport() {
  const summary = state.summary.byCurrency[state.currency];
  const expenses = state.transactions.filter(({ type, currency }) => type === "expense" && (currency || "IDR") === state.currency);
  const report = [
    ["Total pemasukan", summary.income, "income-text"],
    ["Total pengeluaran", summary.expenses, "expense-text"],
    ["Saldo bersih bulan ini", summary.income - summary.expenses, ""],
    ["Saldo kumulatif", summary.balance, ""],
    ["Rata-rata per transaksi", expenses.length ? summary.expenses / expenses.length : 0, ""],
    ["Anggaran terpakai", summary.budgetUsedPercent, ""],
  ];
  $("#report-grid").innerHTML = report.map(([label, value, className]) => `
    <div class="report-item"><span>${label}</span><b class="${className}">${label === "Anggaran terpakai" ? (state.currency === "IDR" ? `${value}%` : "Khusus IDR") : money(value, state.currency)}</b></div>`).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveVaultKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: VAULT_KDF_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function updateVaultLockTimer() {
  clearTimeout(state.vaultLockTimer);
  if (!state.vaultKey) return;
  state.vaultLockTimer = setTimeout(lockVault, 5 * 60 * 1000);
}

function lockVault() {
  clearTimeout(state.vaultLockTimer);
  state.vaultLockTimer = null;
  clearGeneratedVaultKey();
  state.vaultKey = null;
  state.vaultSalt = null;
  state.vaultEntries = [];
  state.revealedCredentials.clear();
  $("#credential-form").reset();
  $("#vault-create-form").reset();
  $("#vault-unlock-form").reset();
  $("#credential-form").classList.add("hidden");
  $("#vault-search").value = "";
  renderVault();
}

function clearGeneratedVaultKey() {
  state.generatedVaultKey = "";
  const keyInput = $("#generated-vault-key");
  if (keyInput) keyInput.value = "";
  $("#generated-vault-key-box")?.classList.add("hidden");
}

function generateVaultKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = bytesToBase64Url(bytes);
  state.generatedVaultKey = key;
  $("#vault-create-form").elements.passphrase.value = key;
  $("#vault-create-form").elements.confirmation.value = key;
  $("#generated-vault-key").value = key;
  $("#generated-vault-key-box").classList.remove("hidden");
}

async function copyGeneratedVaultKey() {
  try {
    await navigator.clipboard.writeText(state.generatedVaultKey);
    toast("Key vault disalin. Simpan di tempat yang aman.");
  } catch {
    toast("Clipboard tidak tersedia. Unduh key atau salin secara manual.");
  }
}

function downloadGeneratedVaultKey() {
  if (!state.generatedVaultKey) {
    toast("Buat key vault terlebih dahulu.");
    return;
  }
  const content = [
    "Autocatat — Key Password Vault",
    "",
    state.generatedVaultKey,
    "",
    "Simpan file ini di tempat aman. Siapa pun yang memiliki key ini dapat membuka vault.",
    "Jangan kirim key melalui chat atau simpan di lokasi yang dapat diakses publik.",
    "",
  ].join("\n");
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  link.href = url;
  link.download = `autocatat-vault-key-${manilaToday()}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("File key vault diunduh. Simpan file dengan aman.");
}

function renderVault() {
  const supported = Boolean(window.isSecureContext && crypto.subtle);
  $("#vault-crypto-warning").classList.toggle("hidden", supported);
  $("#vault-locked").classList.toggle("hidden", Boolean(state.vaultKey));
  $("#vault-content").classList.toggle("hidden", !supported || !state.vaultKey);
  $("#vault-create-form").classList.toggle("hidden", !supported || Boolean(state.vaultRecord));
  $("#vault-unlock-form").classList.toggle("hidden", !supported || !state.vaultRecord);
  if (!state.vaultKey || !supported) return;

  const query = $("#vault-search").value.trim().toLocaleLowerCase();
  const entries = state.vaultEntries.filter((entry) =>
    [entry.site, entry.url, entry.username, entry.notes].some((value) => value.toLocaleLowerCase().includes(query)),
  );
  $("#credential-list").innerHTML = entries.length
    ? entries.map((entry) => {
      let safeUrl = "";
      try {
        const parsed = new URL(entry.url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") safeUrl = parsed.href;
      } catch {}
      const password = state.revealedCredentials.has(entry.id) ? escapeHtml(entry.password) : "••••••••";
      return `
        <article class="credential-card">
          <div class="credential-card-head"><div>
            <h3>${escapeHtml(entry.site)}</h3>
            ${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.url)}</a>` : ""}
          </div></div>
          <div class="credential-meta">
            ${entry.username ? `<div><span class="credential-value-label">Email / username</span><span class="credential-value">${escapeHtml(entry.username)}</span></div>` : ""}
            <div><span class="credential-value-label">Password</span><span class="credential-value">${password}</span></div>
            ${entry.notes ? `<div><span class="credential-value-label">Catatan</span><span class="credential-notes">${escapeHtml(entry.notes)}</span></div>` : ""}
          </div>
          <div class="credential-actions">
            <button type="button" data-reveal-credential="${escapeHtml(entry.id)}">${state.revealedCredentials.has(entry.id) ? "Sembunyikan" : "Lihat password"}</button>
            <button type="button" data-copy-credential="${escapeHtml(entry.id)}">Salin password</button>
            ${entry.username ? `<button type="button" data-copy-username="${escapeHtml(entry.id)}">Salin username</button>` : ""}
            <button type="button" data-edit-credential="${escapeHtml(entry.id)}">Edit</button>
            <button type="button" class="credential-delete" data-delete-credential="${escapeHtml(entry.id)}">Hapus</button>
          </div>
        </article>`;
    }).join("")
    : `<div class="vault-empty">${query ? "Tidak ada akun yang cocok dengan pencarian." : "Belum ada akun tersimpan. Tambahkan akun website atau media sosial pertamamu."}</div>`;
}

async function encryptVault(entries) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(entries));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.vaultKey, plaintext);
  return {
    salt: state.vaultSalt,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    expectedUpdatedAt: state.vaultRecord?.updatedAt ?? null,
  };
}

async function persistVault(entries) {
  const encrypted = await encryptVault(entries);
  const result = await api("/api/vault", { method: "PUT", body: JSON.stringify(encrypted) });
  state.vaultRecord = { ...encrypted, updatedAt: result.updatedAt };
  state.vaultEntries = entries;
  renderVault();
}

function openCredentialEditor(entry) {
  const form = $("#credential-form");
  form.reset();
  form.elements.password.type = "password";
  $("#toggle-entry-password").textContent = "Lihat";
  form.elements.id.value = entry?.id || "";
  form.elements.site.value = entry?.site || "";
  form.elements.url.value = entry?.url || "";
  form.elements.username.value = entry?.username || "";
  form.elements.password.value = entry?.password || "";
  form.elements.notes.value = entry?.notes || "";
  $("#credential-form-title").textContent = entry ? "Edit akun" : "Tambah akun";
  $("#credential-error").classList.add("hidden");
  $("#credential-form").classList.remove("hidden");
  form.elements.site.focus();
}

async function loadVault() {
  lockVault();
  const result = await api("/api/vault");
  state.vaultRecord = result.vault;
  renderVault();
}

function render() {
  $("#month-picker").value = state.month;
  $("#currency-picker").value = state.currency;
  renderSummary();
  const sections = {
    overview: ["Ringkasan keuangan", "Ringkasan"],
    analytics: ["Analisis keuangan", "Analisis"],
    history: ["Riwayat transaksi", "Riwayat transaksi"],
    reports: ["Laporan keuangan", "Laporan"],
    vault: ["Password vault", "Password vault"],
    settings: ["Pengaturan akun", "Pengaturan"],
  };
  const [title, breadcrumb] = sections[state.view];
  $("#page-title").textContent = title;
  $("#breadcrumb-label").textContent = breadcrumb;
  const isVault = state.view === "vault";
  $("#page-eyebrow").textContent = isVault ? "KREDENSIAL PRIBADI" : "KEUANGAN PRIBADI";
  $("#page-description").textContent = isVault
    ? "Semua password dienkripsi di perangkatmu sebelum disimpan."
    : "Pantau arus uangmu, satu langkah kecil setiap hari.";
  $("#page-controls").classList.toggle("hidden", isVault);
  $("#add-button").classList.toggle("hidden", isVault);
  $(".content-grid").classList.toggle("hidden", state.view === "history" || state.view === "reports" || isVault);
  $(".daily-strip").classList.toggle("hidden", state.view === "history" || state.view === "reports" || state.view === "settings" || isVault);
  $("#chart-panel").classList.toggle("hidden", state.view === "history" || state.view === "reports" || state.view === "settings" || isVault);
  $(".category-panel").classList.toggle("hidden", state.view === "history" || state.view === "reports" || state.view === "settings" || isVault);
  $(".wallet-panel").classList.toggle("hidden", state.view !== "overview");
  $("#report-panel").classList.toggle("hidden", state.view !== "reports");
  $("#transactions-panel").classList.toggle("hidden", state.view === "reports" || state.view === "settings" || isVault);
  $("#settings-panel").classList.toggle("hidden", state.view !== "settings");
  $("#vault-panel").classList.toggle("hidden", !isVault);
  $(".hero-card").classList.toggle("hidden", state.view === "settings" || isVault);
  $(".stats-grid").classList.toggle("hidden", state.view === "settings" || isVault);
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  document.querySelectorAll(".mobile-nav-item[data-mobile-view]").forEach((button) => button.classList.toggle("active", button.dataset.mobileView === state.view));
  if (isVault) renderVault();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("visible");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("visible"), 3000);
}

function openDialog(transaction) {
  const form = $("#transaction-form");
  form.reset();
  $("#transaction-id").value = transaction?.id || "";
  $("#dialog-title").textContent = transaction ? "Edit transaksi" : "Tambah transaksi";
  form.elements.type.value = transaction?.type || "expense";
  form.elements.description.value = transaction?.description || "";
  form.elements.amount.value = transaction?.amount || "";
  form.elements.currency.value = transaction?.currency || "IDR";
  form.elements.date.value = transaction?.date || manilaToday();
  form.elements.category.value = transaction?.category || "Lainnya";
  form.elements.wallet.value = transaction?.wallet || "Tunai";
  $("#form-error").classList.add("hidden");
  $("#transaction-dialog").showModal();
}

function exportCsv() {
  const headers = ["Tanggal", "Jenis", "Deskripsi", "Kategori", "Sumber Dana", "Jumlah", "Mata Uang"];
  const rows = state.transactions.map((item) => [item.date, item.type, item.description, item.category, item.wallet, item.amount, item.currency || "IDR"]);
  const escapeCell = (value) => {
    const normalized = /^[=+\-@\t\r]/.test(String(value)) ? `'${value}` : value;
    return `"${String(normalized).replace(/"/g, '""')}"`;
  };
  const content = [headers, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" }));
  link.download = `autocatat-${state.month}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function openIntegrationSettings(targetId) {
  state.view = "settings";
  render();
  try {
    await loadAccountSettings();
    document.getElementById(targetId).scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    toast(error.message);
  }
}

function bindEvents() {
  $("#telegram-connection").addEventListener("click", () => {
    void openIntegrationSettings("telegram-settings-card");
  });
  $("#sheets-connection").addEventListener("click", () => {
    void openIntegrationSettings("sheets-settings-card");
  });
  $("#firebase-connection").addEventListener("click", () => {
    toast(state.config?.firebase
      ? "Firebase adalah backend penyimpanan bersama. Status realtime ditampilkan di indikator ini; konfigurasi dilakukan oleh administrator server."
      : "Firebase tidak aktif. Aplikasi memakai penyimpanan lokal server; konfigurasi Firebase dilakukan oleh administrator server.");
  });
  $("#auth-switch").addEventListener("click", () => {
    showAuthScreen($("#register-form").classList.contains("hidden") ? "register" : "login");
  });
  $("#mobile-add-button").addEventListener("click", () => openDialog());
  $("#mobile-menu-button").addEventListener("click", (event) => {
    const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
    event.currentTarget.setAttribute("aria-expanded", String(!expanded));
    $(".sidebar").classList.toggle("mobile-menu-open", !expanded);
  });
  document.querySelectorAll("[data-mobile-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.mobileView;
    $(".sidebar").classList.remove("mobile-menu-open");
    $("#mobile-menu-button").setAttribute("aria-expanded", "false");
    render();
  }));
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await completeAuth(await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      }));
    } catch (error) {
      $("#auth-error").textContent = error.message;
      $("#auth-error").classList.remove("hidden");
    } finally { submit.disabled = false; }
  });
  $("#setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await completeAuth(await api("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      }));
    } catch (error) {
      $("#auth-error").textContent = error.message;
      $("#auth-error").classList.remove("hidden");
    } finally { submit.disabled = false; }
  });
  $("#register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await completeAuth(await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      }));
    } catch (error) {
      $("#auth-error").textContent = error.message;
      $("#auth-error").classList.remove("hidden");
    } finally { submit.disabled = false; }
  });
  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
      lockVault();
      state.firebaseEvents?.close();
      state.firebaseEvents = null;
      clearInterval(state.realtimePollingTimer);
      state.realtimePollingTimer = null;
      state.user = null;
      state.csrfToken = "";
      showAuthScreen("login");
      toast("Kamu sudah keluar.");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#month-picker").addEventListener("change", async (event) => {
    if (!event.target.value) return;
    state.month = event.target.value;
    try { await refresh(); } catch (error) { toast(error.message); }
  });
  $("#currency-picker").addEventListener("change", (event) => {
    state.currency = event.target.value;
    render();
  });
  $("#refresh-button").addEventListener("click", async () => {
    try { await refresh(); toast("Data berhasil diperbarui."); } catch (error) { toast(error.message); }
  });
  $("#add-button").addEventListener("click", () => openDialog());
  $("#empty-add-button").addEventListener("click", () => openDialog());
  $("#dialog-close").addEventListener("click", () => $("#transaction-dialog").close());
  $("#cancel-button").addEventListener("click", () => $("#transaction-dialog").close());
  $("#toggle-balance").addEventListener("click", () => {
    state.balanceHidden = !state.balanceHidden;
    $("#balance-value").textContent = state.balanceHidden
      ? "••••••••"
      : money(state.summary.byCurrency[state.currency].balance, state.currency);
  });
  $("#help-button").addEventListener("click", () => {
    window.alert("1. Buat akun dengan email dan kata sandi tanpa kode undangan.\n2. Catat transaksi lewat tombol Tambah transaksi atau tautkan Telegram dari Pengaturan.\n3. Kirim contoh “makan siang 35rb”, foto struk, atau voice note.\n4. Simpan kredensial di Password vault dengan passphrase vault tersendiri.\n5. Gunakan menu Analisis, Riwayat transaksi, dan Laporan untuk melihat serta mengunduh data.");
  });
  $("#export-button").addEventListener("click", exportCsv);
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    const nextView = button.dataset.view;
    if (state.view === "vault" && nextView !== "vault") lockVault();
    state.view = nextView;
    $(".sidebar").classList.remove("mobile-menu-open");
    $("#mobile-menu-button").setAttribute("aria-expanded", "false");
    render();
    if (state.view === "settings") {
      loadAccountSettings().catch((error) => toast(error.message));
    }
    if (state.view === "vault") loadVault().catch((error) => toast(error.message));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  $(".more-button").addEventListener("click", () => {
    if (state.view === "vault") lockVault();
    state.view = "settings";
    render();
    loadAccountSettings().catch((error) => toast(error.message));
  });
  $("#profile-settings").addEventListener("click", () => {
    if (state.view === "vault") lockVault();
    state.view = "settings";
    render();
    loadAccountSettings().catch((error) => toast(error.message));
  });
  $("#budget-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const monthlyBudget = Number(event.currentTarget.elements.monthlyBudget.value);
    try {
      await api("/api/account", { method: "PATCH", body: JSON.stringify({ monthlyBudget }) });
      await refresh();
      await loadAccountSettings();
      toast("Anggaran bulanan berhasil diperbarui.");
    } catch (error) { toast(error.message); }
  });
  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/auth/password", {
        method: "PATCH",
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      });
      form.reset();
      toast("Kata sandi berhasil diperbarui. Sesi lain sudah dikeluarkan.");
    } catch (error) { toast(error.message); }
  });
  $("#vault-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const passphrase = values.get("passphrase");
    if (passphrase !== values.get("confirmation")) {
      toast("Konfirmasi passphrase tidak cocok.");
      return;
    }
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      state.vaultSalt = bytesToBase64Url(salt);
      state.vaultKey = await deriveVaultKey(passphrase, salt);
      state.vaultEntries = [];
      await persistVault([]);
      form.reset();
      clearGeneratedVaultKey();
      updateVaultLockTimer();
      toast("Password vault berhasil dibuat dan dibuka.");
    } catch (error) {
      lockVault();
      toast(error.message);
    }
  });
  $("#generate-vault-key").addEventListener("click", generateVaultKey);
  $("#copy-vault-key").addEventListener("click", copyGeneratedVaultKey);
  $("#download-vault-key").addEventListener("click", downloadGeneratedVaultKey);
  ["passphrase", "confirmation"].forEach((name) => {
    $("#vault-create-form").elements[name].addEventListener("input", () => {
      if (state.generatedVaultKey && (
        $("#vault-create-form").elements.passphrase.value !== state.generatedVaultKey ||
        $("#vault-create-form").elements.confirmation.value !== state.generatedVaultKey
      )) clearGeneratedVaultKey();
    });
  });
  $("#vault-unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const passphrase = new FormData(form).get("passphrase");
    try {
      const record = state.vaultRecord;
      const salt = base64UrlToBytes(record.salt);
      const key = await deriveVaultKey(passphrase, salt);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64UrlToBytes(record.iv) },
        key,
        base64UrlToBytes(record.ciphertext),
      );
      const entries = JSON.parse(new TextDecoder().decode(plaintext));
      if (!Array.isArray(entries) || entries.length > 1000 || entries.some((entry) =>
        !entry || typeof entry.id !== "string" || typeof entry.site !== "string" ||
        typeof entry.url !== "string" || typeof entry.username !== "string" ||
        typeof entry.password !== "string" || typeof entry.notes !== "string"
      )) throw new Error("Format data vault tidak valid.");
      state.vaultSalt = record.salt;
      state.vaultKey = key;
      state.vaultEntries = entries;
      form.reset();
      renderVault();
      updateVaultLockTimer();
    } catch {
      form.reset();
      toast("Passphrase salah atau data vault tidak dapat dibuka.");
    }
  });
  $("#vault-search").addEventListener("input", renderVault);
  $("#vault-lock-button").addEventListener("click", () => {
    lockVault();
    toast("Password vault dikunci.");
  });
  $("#vault-new-entry").addEventListener("click", () => openCredentialEditor());
  $("#credential-cancel").addEventListener("click", () => {
    $("#credential-form").reset();
    $("#credential-form").classList.add("hidden");
  });
  $("#toggle-entry-password").addEventListener("click", (event) => {
    const password = $("#credential-form").elements.password;
    password.type = password.type === "password" ? "text" : "password";
    event.currentTarget.textContent = password.type === "password" ? "Lihat" : "Sembunyikan";
  });
  $("#generate-password").addEventListener("click", () => {
    const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*()-_=+[]{}"];
    const all = groups.join("");
    const randomIndex = (length) => crypto.getRandomValues(new Uint32Array(1))[0] % length;
    const characters = groups.map((group) => group[randomIndex(group.length)]);
    while (characters.length < 24) characters.push(all[randomIndex(all.length)]);
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swap = randomIndex(index + 1);
      [characters[index], characters[swap]] = [characters[swap], characters[index]];
    }
    $("#credential-form").elements.password.value = characters.join("");
    $("#credential-form").elements.password.type = "text";
    $("#toggle-entry-password").textContent = "Sembunyikan";
  });
  $("#credential-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    $("#credential-error").classList.add("hidden");
    const values = new FormData(form);
    let url = String(values.get("url")).trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
        url = parsed.href;
      } catch {
        $("#credential-error").textContent = "URL harus menggunakan HTTP atau HTTPS yang valid.";
        $("#credential-error").classList.remove("hidden");
        return;
      }
    }
    const previous = state.vaultEntries.find((entry) => entry.id === values.get("id"));
    const entry = {
      id: previous?.id || crypto.randomUUID(),
      site: String(values.get("site")).trim(),
      url,
      username: String(values.get("username")).trim(),
      password: String(values.get("password")),
      notes: String(values.get("notes")).trim(),
      updatedAt: Date.now(),
    };
    const entries = previous
      ? state.vaultEntries.map((item) => item.id === entry.id ? entry : item)
      : [entry, ...state.vaultEntries];
    try {
      await persistVault(entries);
      form.reset();
      form.classList.add("hidden");
      $("#toggle-entry-password").textContent = "Lihat";
      updateVaultLockTimer();
      toast("Kredensial terenkripsi dan berhasil disimpan.");
    } catch (error) { toast(error.message); }
  });
  $("#credential-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const entryId = button.dataset.revealCredential || button.dataset.copyCredential ||
      button.dataset.copyUsername || button.dataset.editCredential || button.dataset.deleteCredential;
    const entry = state.vaultEntries.find(({ id }) => id === entryId);
    if (!entry) return;
    if (button.dataset.revealCredential) {
      if (state.revealedCredentials.has(entryId)) state.revealedCredentials.delete(entryId);
      else state.revealedCredentials.add(entryId);
      renderVault();
    } else if (button.dataset.editCredential) {
      openCredentialEditor(entry);
    } else if (button.dataset.deleteCredential) {
      if (!window.confirm(`Hapus kredensial ${entry.site}? Tindakan ini tidak dapat dibatalkan.`)) return;
      try {
        await persistVault(state.vaultEntries.filter(({ id }) => id !== entryId));
        updateVaultLockTimer();
        toast("Kredensial berhasil dihapus.");
      } catch (error) { toast(error.message); }
    } else {
      try {
        await navigator.clipboard.writeText(button.dataset.copyUsername ? entry.username : entry.password);
        updateVaultLockTimer();
        toast(button.dataset.copyUsername ? "Username disalin." : "Password disalin.");
      } catch {
        toast("Clipboard tidak tersedia. Salin kredensial secara manual.");
      }
    }
  });
  document.addEventListener("pointerdown", () => {
    if (state.vaultKey) updateVaultLockTimer();
  });
  document.addEventListener("keydown", () => {
    if (state.vaultKey) updateVaultLockTimer();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.vaultKey) lockVault();
  });
  $("#link-telegram-button").addEventListener("click", async () => {
    try {
      const result = await api("/api/telegram/link-code", { method: "POST", body: "{}" });
      const box = $("#link-code-box");
      box.textContent = result.botUsername
        ? `Buka Telegram @${result.botUsername}, lalu kirim: ${result.command} (berlaku 10 menit).`
        : `Kirim perintah ini ke bot Telegram (berlaku 10 menit): ${result.command}`;
      box.classList.remove("hidden");
    } catch (error) { toast(error.message); }
  });
  $("#unlink-telegram-button").addEventListener("click", async () => {
    if (!window.confirm("Putuskan tautan akun Telegram ini?")) return;
    try {
      await api("/api/telegram/unlink", { method: "POST", body: "{}" });
      await loadAccountSettings();
      toast("Telegram berhasil diputuskan.");
    } catch (error) { toast(error.message); }
  });
  $("#user-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-disable-user]");
    if (!button || !window.confirm("Nonaktifkan akun ini? Data transaksi tetap disimpan, tetapi pengguna tidak bisa login atau memakai bot.")) return;
    try {
      await api(`/api/admin/users/${button.dataset.disableUser}`, { method: "DELETE" });
      await loadAdminUsers();
      toast("Akun berhasil dinonaktifkan.");
    } catch (error) { toast(error.message); }
  });
  $("#transaction-rows").addEventListener("click", async (event) => {
    const editButton = event.target.closest("[data-edit]");
    const deleteButton = event.target.closest("[data-delete]");
    if (editButton) {
      const transaction = state.transactions.find(({ id }) => id === editButton.dataset.edit);
      if (transaction) openDialog(transaction);
    } else if (deleteButton && window.confirm("Hapus transaksi ini? Tindakan ini tidak dapat dibatalkan.")) {
      try {
        const result = await api(`/api/transactions/${deleteButton.dataset.delete}`, { method: "DELETE" });
        await refresh();
        toast(result.sheetError ? `Dihapus lokal, tetapi Sheets gagal: ${result.sheetError}` : "Transaksi berhasil dihapus.");
      } catch (error) { toast(error.message); }
    }
  });
  $("#transaction-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.amount = Number(payload.amount);
    const id = $("#transaction-id").value;
    const save = $("#save-button");
    save.disabled = true;
    save.textContent = "Menyimpan…";
    try {
      const result = await api(id ? `/api/transactions/${id}` : "/api/transactions", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      $("#transaction-dialog").close();
      await refresh();
      toast(result.sheetError
        ? `Tersimpan lokal, tetapi Sheets gagal: ${result.sheetError}`
        : id ? "Transaksi berhasil diperbarui." : "Transaksi berhasil dicatat.");
    } catch (error) {
      $("#form-error").textContent = error.message;
      $("#form-error").classList.remove("hidden");
    } finally {
      save.disabled = false;
      save.textContent = "Simpan transaksi";
    }
  });
}

async function start() {
  const categoryInput = $("#category-input");
  categoryInput.innerHTML = ["Makanan & Minuman", "Transportasi", "Belanja", "Kebutuhan Rumah Tangga", "Tagihan", "Kesehatan", "Hiburan", "Pendidikan", "Pemasukan", "Lainnya"]
    .map((category) => `<option>${escapeHtml(category)}</option>`).join("");
  bindEvents();
  try {
    state.authStatus = await api("/api/auth/status");
    if (!state.authStatus.hasUsers && state.authStatus.setupEnabled) {
      showAuthScreen("setup");
      return;
    }
    if (!state.authStatus.hasUsers) {
      showAuthScreen("unavailable");
      return;
    }
    try {
      const auth = await api("/api/auth/me");
      state.user = auth.user;
      state.csrfToken = auth.csrfToken;
      showAuthenticatedApp();
      await refresh();
    } catch (error) {
      if (!String(error.message).includes("masuk")) throw error;
      showAuthScreen("login");
    }
  } catch (error) {
    showAuthScreen(state.authStatus?.hasUsers ? "login" : state.authStatus ? "unavailable" : "service-error");
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  }
}

start();
