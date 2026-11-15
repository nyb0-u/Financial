const test = require("node:test");
const assert = require("node:assert/strict");
const { manilaDate, normalizeTransaction, parseTransaction, summarize } = require("../src/finance");

test("uses Makati/Manila local date at the UTC day boundary", () => {
  assert.equal(manilaDate(new Date("2026-01-01T16:30:00Z")), "2026-01-02");
});

test("parses everyday Indonesian expense text with grouped rupiah amount", () => {
  const result = parseTransaction("makan siang Rp35.000 via e-wallet");
  assert.equal(result.amount, 35_000);
  assert.equal(result.type, "expense");
  assert.equal(result.category, "Makanan & Minuman");
  assert.equal(result.wallet, "E-Wallet");
  assert.match(result.description, /makan siang/i);
});

test("parses income and short Indonesian amount suffixes", () => {
  const result = parseTransaction("gaji masuk 5 juta ke rekening");
  assert.equal(result.amount, 5_000_000);
  assert.equal(result.type, "income");
  assert.equal(result.category, "Pemasukan");
  assert.equal(result.wallet, "Rekening");
});

test("parses decimal million shorthand and household categories", () => {
  const result = parseTransaction("belanja kebutuhan rumah 1,5jt");
  assert.equal(result.amount, 1_500_000);
  assert.equal(result.category, "Kebutuhan Rumah Tangga");
});

test("parses Philippine peso and US dollar amounts without changing the numeric value", () => {
  const peso = parseTransaction("Makan siang 10 Peso");
  assert.equal(peso.amount, 10);
  assert.equal(peso.currency, "PHP");
  assert.match(peso.description, /Makan siang/i);

  const pesoSymbol = parseTransaction("kopi ₱125");
  assert.equal(pesoSymbol.amount, 125);
  assert.equal(pesoSymbol.currency, "PHP");

  const dollars = parseTransaction("lunch $12.50");
  assert.equal(dollars.amount, 12.5);
  assert.equal(dollars.currency, "USD");

  const groupedDollars = parseTransaction("groceries USD 1,234.56");
  assert.equal(groupedDollars.amount, 1234.56);
  assert.equal(groupedDollars.currency, "USD");
});

test("rejects invalid amounts, types, and impossible dates", () => {
  assert.throws(() => normalizeTransaction({ amount: 0, type: "expense", description: "Makan" }), /Nominal/);
  assert.throws(() => normalizeTransaction({ amount: 1000, type: "refund", description: "Makan" }), /Jenis transaksi/);
  assert.throws(() => normalizeTransaction({ amount: 1000, type: "expense", description: "Makan", date: "2026-02-31" }), /Tanggal/);
  assert.throws(() => normalizeTransaction({ amount: 1.5, currency: "IDR", type: "expense", description: "Makan" }), /IDR/);
});

test("summarizes monthly totals, all-time balance, and category totals", () => {
  const transactions = [
    { amount: 1_000_000, type: "income", category: "Pemasukan", wallet: "Rekening", date: "2026-08-01" },
    { amount: 250_000, type: "expense", category: "Belanja", wallet: "E-Wallet", date: "2026-08-04" },
    { amount: 50_000, type: "expense", category: "Makanan & Minuman", wallet: "Tunai", date: "2026-08-05" },
    { amount: 500_000, type: "income", category: "Pemasukan", wallet: "Rekening", date: "2026-07-01" },
  ];
  const summary = summarize(transactions, "2026-08", 500_000);
  assert.equal(summary.income, 1_000_000);
  assert.equal(summary.expenses, 300_000);
  assert.equal(summary.balance, 1_200_000);
  assert.equal(summary.budgetRemaining, 200_000);
  assert.equal(summary.byCategory.Belanja, 250_000);
  assert.equal(summary.byWallet.Rekening, 1_500_000);
});

test("keeps monthly and all-time summaries separate for each currency", () => {
  const transactions = [
    { amount: 100, currency: "USD", type: "income", category: "Pemasukan", wallet: "Tunai", date: "2026-08-01" },
    { amount: 12.5, currency: "USD", type: "expense", category: "Makanan & Minuman", wallet: "Tunai", date: "2026-08-02" },
    { amount: 500, currency: "PHP", type: "expense", category: "Belanja", wallet: "Tunai", date: "2026-08-03" },
  ];
  const summary = summarize(transactions, "2026-08", 1_000_000);
  assert.equal(summary.income, 0);
  assert.equal(summary.byCurrency.USD.balance, 87.5);
  assert.equal(summary.byCurrency.USD.expenses, 12.5);
  assert.equal(summary.byCurrency.PHP.expenses, 500);
  assert.equal(summary.byCurrency.IDR.monthlyBudget, 1_000_000);
});
