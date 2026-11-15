const CATEGORIES = [
  "Makanan & Minuman",
  "Transportasi",
  "Belanja",
  "Kebutuhan Rumah Tangga",
  "Tagihan",
  "Kesehatan",
  "Hiburan",
  "Pendidikan",
  "Pemasukan",
  "Lainnya",
];
const CURRENCIES = ["IDR", "USD", "PHP"];

function manilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeTransaction(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Data transaksi tidak valid.");
  }

  const amount = Number(input.amount);
  const currency = input.currency === undefined ? "IDR" : input.currency;
  if (!CURRENCIES.includes(currency)) {
    throw new Error("Mata uang harus IDR, USD, atau PHP.");
  }
  const minorUnits = Math.round(amount * 100);
  if (
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(minorUnits) ||
    minorUnits <= 0 ||
    Math.abs(amount * 100 - minorUnits) > 1e-7 ||
    (currency === "IDR" && minorUnits % 100 !== 0)
  ) {
    throw new Error(`Nominal ${currency} harus positif${currency === "IDR" ? " dan berupa bilangan bulat" : " dengan maksimal 2 angka desimal"}.`);
  }

  const type = input.type;
  if (type !== "income" && type !== "expense") {
    throw new Error("Jenis transaksi harus pemasukan atau pengeluaran.");
  }

  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description || description.length > 160) {
    throw new Error("Deskripsi transaksi wajib diisi (maksimal 160 karakter).");
  }

  const date = typeof input.date === "string" ? input.date : manilaDate();
  const parsedDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const dateObject = parsedDate ? new Date(Date.UTC(Number(parsedDate[1]), Number(parsedDate[2]) - 1, Number(parsedDate[3]))) : null;
  if (
    !parsedDate ||
    dateObject.getUTCFullYear() !== Number(parsedDate[1]) ||
    dateObject.getUTCMonth() + 1 !== Number(parsedDate[2]) ||
    dateObject.getUTCDate() !== Number(parsedDate[3])
  ) {
    throw new Error("Tanggal transaksi tidak valid.");
  }

  const category = type === "income"
    ? "Pemasukan"
    : CATEGORIES.includes(input.category) && input.category !== "Pemasukan"
    ? input.category
    : "Lainnya";
  const wallet = typeof input.wallet === "string" && input.wallet.trim()
    ? input.wallet.trim().slice(0, 40)
    : "Tunai";

  return { amount: minorUnits / 100, currency, type, description, category, wallet, date };
}

function parseAmount(text) {
  const match = text.match(/(?:\b(?:rp|idr|php|usd)\b\.?\s*|us\s*\$\s*|[$₱]\s*)?(\d+(?:[.,]\d+)*)(?:\s*(juta|jt|ribu|rb|k))?(?:\s*(?:rupiah|pesos?|pisos?))?/i);
  if (!match) return null;

  const raw = match[1];
  const suffix = (match[2] || "").toLowerCase();
  const separators = [...raw.matchAll(/[.,]/g)].map((item) => item.index);
  let normalized = raw;
  if (separators.length) {
    const lastSeparator = separators[separators.length - 1];
    const decimalDigits = raw.length - lastSeparator - 1;
    const hasBothSeparators = raw.includes(".") && raw.includes(",");
    if (hasBothSeparators || (decimalDigits !== 3 && decimalDigits <= 2)) {
      const decimalSeparator = raw[lastSeparator];
      normalized = raw.slice(0, lastSeparator).replace(/[.,]/g, "") + "." + raw.slice(lastSeparator + 1);
    } else {
      normalized = raw.replace(/[.,]/g, "");
    }
  }
  let amount = Number(normalized);
  if (suffix) {
    amount *= ["juta", "jt"].includes(suffix) ? 1_000_000 : 1_000;
  }

  return Number.isFinite(amount) && Math.round(amount * 100) > 0 ? Math.round(amount * 100) / 100 : null;
}

function categoryFor(text, type) {
  if (type === "income") return "Pemasukan";
  const rules = [
    ["Makanan & Minuman", /\b(makan|minum|kopi|resto|restoran|warung|bakso|ojol food|gofood|grabfood|sayur)\b/i],
    ["Transportasi", /\b(transport|bensin|bbm|parkir|tol|bus|kereta|grab|gojek|ojek|taksi|taxi)\b/i],
    ["Kebutuhan Rumah Tangga", /\b(rumah|dapur|sabun|detergen|deterjen|perabot|mr\.?\s*d\.?\s*i\.?\s*y\.?|ikea)\b/i],
    ["Tagihan", /\b(tagihan|listrik|air|internet|wifi|pulsa|pascabayar|bpjs)\b/i],
    ["Kesehatan", /\b(obat|dokter|klinik|rumah sakit|apotek|kesehatan)\b/i],
    ["Pendidikan", /\b(sekolah|kuliah|buku|kursus|pendidikan|les)\b/i],
    ["Hiburan", /\b(nonton|bioskop|game|hiburan|netflix|spotify|konser)\b/i],
    ["Belanja", /\b(belanja|beli|market|supermarket|minimarket|toko|shopee|tokopedia)\b/i],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "Lainnya";
}

function parseTransaction(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Tulis transaksi yang ingin dicatat.");
  }
  const amount = parseAmount(text);
  if (!amount) throw new Error("Nominal belum terbaca. Contoh: makan siang 35rb.");
  const currency = /(?:₱|\bphp\b|\bpesos?\b|\bpisos?\b)/i.test(text)
    ? "PHP"
    : /(?:\bUSD\b|US\s*\$|(?<![\w])\$)/i.test(text)
      ? "USD"
      : "IDR";

  const type = /\b(gaji|pemasukan|pendapatan|bonus|masuk|dapat|terima|refund)\b/i.test(text)
    ? "income"
    : "expense";
  const amountMatch = text.match(/(?:\b(?:rp|idr|php|usd)\b\.?\s*|us\s*\$\s*|[$₱]\s*)?\d+(?:[.,]\d+)*(?:\s*(?:juta|jt|ribu|rb|k))?(?:\s*(?:rupiah|pesos?|pisos?))?/i);
  let description = text
    .replace(amountMatch?.[0] || "", " ")
    .replace(/(?:\b(?:rp|idr|php|usd|rupiah|pesos?|pisos?)\b|us\s*\$|[$₱])/gi, " ")
    .replace(/\b(pengeluaran|pemasukan|pendapatan|catat|aku|saya|beli|bayar|habis|untuk|sebesar)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!description) description = type === "income" ? "Pemasukan" : "Transaksi";

  const wallet = /\b(e-?wallet|gopay|ovo|dana|shopeepay|linkaja)\b/i.test(text)
    ? "E-Wallet"
    : /\b(kartu kredit|credit card)\b/i.test(text)
      ? "Kartu Kredit"
      : /\b(transfer|rekening|bank)\b/i.test(text)
        ? "Rekening"
        : "Tunai";

  return normalizeTransaction({
    amount,
    currency,
    type,
    description,
    category: categoryFor(text, type),
    wallet,
    date: manilaDate(),
  });
}

function summarize(transactions, month, monthlyBudget) {
  const monthTransactions = transactions.filter((item) => item.date.startsWith(month));
  const today = manilaDate();
  const byCurrency = Object.fromEntries(CURRENCIES.map((currency) => {
    const matchesCurrency = (item) => (item.currency || "IDR") === currency;
    const currencyMonth = monthTransactions.filter(matchesCurrency);
    const currencyTransactions = transactions.filter(matchesCurrency);
    const todayTransactions = currencyTransactions.filter((item) => item.date === today);
    const income = currencyMonth
      .filter((item) => item.type === "income")
      .reduce((total, item) => total + item.amount, 0);
    const expenses = currencyMonth
      .filter((item) => item.type === "expense")
      .reduce((total, item) => total + item.amount, 0);
    const balance = currencyTransactions.reduce(
      (total, item) => total + (item.type === "income" ? item.amount : -item.amount),
      0,
    );
    const byCategory = Object.fromEntries(
      currencyMonth
        .filter((item) => item.type === "expense")
        .reduce((totals, item) => totals.set(item.category, (totals.get(item.category) || 0) + item.amount), new Map()),
    );
    const byWallet = Object.fromEntries(
      currencyTransactions.reduce((totals, item) => {
        const current = totals.get(item.wallet) || 0;
        totals.set(item.wallet, current + (item.type === "income" ? item.amount : -item.amount));
        return totals;
      }, new Map()),
    );
    const budget = currency === "IDR" ? monthlyBudget : 0;
    return [currency, {
      currency,
      balance,
      income,
      expenses,
      monthlyBudget: budget,
      budgetRemaining: budget - expenses,
      budgetUsedPercent: budget > 0 ? Math.min(100, Math.round((expenses / budget) * 100)) : 0,
      todayIncome: todayTransactions.filter((item) => item.type === "income").reduce((total, item) => total + item.amount, 0),
      todayExpenses: todayTransactions.filter((item) => item.type === "expense").reduce((total, item) => total + item.amount, 0),
      todayTransactionCount: todayTransactions.length,
      byCategory,
      byWallet,
      transactionCount: currencyMonth.length,
    }];
  }));
  return {
    month,
    ...byCurrency.IDR,
    byCurrency,
  };
}

module.exports = { CATEGORIES, CURRENCIES, manilaDate, normalizeTransaction, parseTransaction, summarize };
