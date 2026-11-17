// The money rules for TallyUp: winnings, who owes whom, currency conversion
// and settling up. No page code, so every rule can be tested on its own.

export const STORAGE_KEY = "tallyup.v1";
export const BACKUP_FORMAT = "tallyup-backup-1";
export const RECORD_TYPES = ["card", "bet", "split", "payment"];
export const BET_RESULTS = ["win", "lose", "cashout"];

export function emptyBook() {
  return { members: [], records: [], settings: { lang: "zh", currency: "CNY" }, rates: null };
}

// Rounds to cents, so 0.1 + 0.2 shows as 0.3.
export function roundMoney(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

// Reads what someone typed as an amount, or NaN if it isn't one. Accepts
// "12", "12.5", "1,200", full-width digits like "３０", and a decimal comma
// ("12,5" is 12.5, never 125). decimalMark is the language's own: with ","
// (Spanish), "1.200" is twelve hundred and "1,2" is one point two. Rounded
// to cents.
export function parseAmount(text, decimalMark = ".") {
  const cleaned = String(text ?? "").normalize("NFKC").replace(/\s/g, "");
  if (!/^[\d.,]*\d[\d.,]*$/.test(cleaned)) {
    return NaN;
  }
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both marks: the last one is the decimal point, as in 1.234,56 or 1,234.56.
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? "." : ",";
    const at = cleaned.lastIndexOf(mark);
    const usedOnce = cleaned.indexOf(mark) === at;
    // One mark before exactly three digits groups thousands, unless it's this
    // language's decimal mark.
    const groupsThousands = cleaned.length - at - 1 === 3 && mark !== decimalMark;
    if (usedOnce && !groupsThousands) {
      decimalAt = at;
    }
  }
  const whole = decimalAt >= 0 ? cleaned.slice(0, decimalAt) : cleaned;
  const fraction = decimalAt >= 0 ? cleaned.slice(decimalAt + 1) : "";
  // Any marks left in the whole number must group it in threes: 1,200 or 1.200.000.
  if (!/^(\d*|\d{1,3}([.,]\d{3})+)$/.test(whole) || !/^\d*$/.test(fraction)) {
    return NaN;
  }
  return roundMoney(Number(`${whole.replace(/[.,]/g, "") || "0"}.${fraction || "0"}`));
}

export function isRealDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  if (!match) {
    return false;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return year >= 1 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// The local calendar date as YYYY-MM-DD.
export function localDateKey(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// What one bet means for the person who placed it. The max payout includes
// the stake (Thomas, 2026-11-11), so a win gains the payout minus the stake,
// a loss loses the stake, and a cash out gains (or loses) the cash-out amount
// minus the stake.
export function betResult({ stake, payout, result, cashout }) {
  if (result === "win") {
    return roundMoney(payout - stake);
  }
  if (result === "lose") {
    return roundMoney(-stake);
  }
  return roundMoney(cashout - stake);
}

// Each member's win (+) or loss (-) from one record, in the record's
// currency. An AA split is spending and a payment is paying back, not
// winning, so neither counts for anybody.
export function recordWinnings(record) {
  if (record.type === "card") {
    return { ...record.amounts };
  }
  if (record.type === "bet") {
    return { [record.bettorId]: betResult(record) };
  }
  return {};
}

// What each member should receive (+) or pay (-) because of one record.
// Bets are settled afterwards between the bettor and the account holder: the
// holder pays out a gain and collects a loss. A bet on the holder's own
// account needs no transfer.
export function recordBalances(record) {
  if (record.type === "card") {
    return { ...record.amounts };
  }
  if (record.type === "bet") {
    if (record.bettorId === record.holderId) {
      return {};
    }
    const result = betResult(record);
    return { [record.bettorId]: result, [record.holderId]: roundMoney(-result) };
  }
  // A payment ("已付" on the settle page): the payer has paid part of what
  // they owe, so they owe that much less and the receiver is owed that much less.
  if (record.type === "payment") {
    return { [record.fromId]: record.amount, [record.toId]: roundMoney(-record.amount) };
  }
  // AA split: the payer is owed the whole amount, and each person in the
  // split owes their share (the payer too, if they're in it). Everything is
  // in cents so nothing is lost to rounding.
  const cents = Math.round(record.amount * 100);
  if (record.shares) {
    // Shares typed in by hand, which add up to the amount.
    const balances = { [record.payerId]: cents };
    for (const [id, share] of Object.entries(record.shares)) {
      balances[id] = (balances[id] ?? 0) - Math.round(share * 100);
    }
    for (const id of Object.keys(balances)) {
      balances[id] = balances[id] / 100;
    }
    return balances;
  }
  // Equal shares: a cent left over (100 three ways) goes to the payer first,
  // so the others pay exactly the share shown.
  const people = [...record.participantIds].sort((a, b) => (b === record.payerId) - (a === record.payerId));
  const baseShare = Math.floor(cents / people.length);
  let leftover = cents - baseShare * people.length;
  const balances = { [record.payerId]: cents };
  for (const id of people) {
    const share = baseShare + (leftover > 0 ? 1 : 0);
    leftover -= 1;
    balances[id] = (balances[id] ?? 0) - share;
  }
  for (const id of Object.keys(balances)) {
    balances[id] = balances[id] / 100;
  }
  return balances;
}

// rates: { base: "EUR", rates: { USD: 1.08, CNY: 7.7, ... } }, meaning
// 1 unit of base equals that many of each currency. Returns null when a rate
// isn't known, so a missing rate is never treated as 1 or 0.
export function convert(amount, from, to, rates) {
  if (from === to) {
    return amount;
  }
  const rateOf = (code) => (rates && code === rates.base ? 1 : rates?.rates?.[code]);
  const fromRate = rateOf(from);
  const toRate = rateOf(to);
  if (!fromRate || !toRate) {
    return null;
  }
  return (amount / fromRate) * toRate;
}

// Adds up, per member, the amounts that pick(record) gives, converted to one
// currency. Records whose currency can't be converted are listed in missing.
export function sumByMember(records, pick, currency, rates) {
  const totals = {};
  const missing = new Set();
  for (const record of records) {
    for (const [id, amount] of Object.entries(pick(record))) {
      const converted = convert(amount, record.currency, currency, rates);
      if (converted === null) {
        missing.add(record.currency);
        continue;
      }
      totals[id] = (totals[id] ?? 0) + converted;
    }
  }
  for (const id of Object.keys(totals)) {
    totals[id] = roundMoney(totals[id]);
  }
  return { totals, missing: [...missing] };
}

// Turns balances (+ receive, - pay) into a short list of transfers: the
// person who owes the most pays the person owed the most, and so on. Amounts
// under half a cent are treated as settled.
export function settleUp(balances) {
  const people = Object.entries(balances).map(([id, amount]) => ({ id, amount: roundMoney(amount) }));
  const creditors = people.filter((person) => person.amount >= 0.005).sort((a, b) => b.amount - a.amount);
  const debtors = people
    .filter((person) => person.amount <= -0.005)
    .map((person) => ({ id: person.id, amount: -person.amount }))
    .sort((a, b) => b.amount - a.amount);
  const transfers = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = roundMoney(Math.min(creditors[c].amount, debtors[d].amount));
    if (amount >= 0.01) {
      transfers.push({ from: debtors[d].id, to: creditors[c].id, amount });
    }
    creditors[c].amount = roundMoney(creditors[c].amount - amount);
    debtors[d].amount = roundMoney(debtors[d].amount - amount);
    if (creditors[c].amount < 0.005) {
      c += 1;
    }
    if (debtors[d].amount < 0.005) {
      d += 1;
    }
  }
  return transfers;
}

// The settle page's plan for the unsettled records, in the main currency:
// { balances, transfers, missing }. A transfer marked refund: true is money
// going back to someone who paid too much. That happens when a payment was
// recorded and then the records changed (an AA share made smaller, or an AA
// deleted): the payment stays, so the payer ends up owed money. Refunds go
// back to the person they paid, as long as that doesn't take more transfers
// than settleUp would; otherwise settleUp's shortest list is used.
export function settlementPlan(records, currency, rates) {
  const unsettled = records.filter((record) => !record.settled);
  const { totals: balances, missing } = sumByMember(unsettled, recordBalances, currency, rates);
  const shortest = settleUp(balances);
  const refunds = refundTransfers(unsettled, balances, currency, rates);
  if (!refunds.length) {
    return { balances, transfers: shortest, missing };
  }
  const rest = { ...balances };
  for (const refund of refunds) {
    rest[refund.to] = roundMoney(rest[refund.to] - refund.amount);
    rest[refund.from] = roundMoney(rest[refund.from] + refund.amount);
  }
  const withRefunds = [...refunds, ...settleUp(rest)];
  return { balances, transfers: withRefunds.length <= shortest.length ? withRefunds : shortest, missing };
}

// Someone who is owed money and has paid someone else (net of anything paid
// back) gets the smaller of the two back from the person they paid.
function refundTransfers(unsettled, balances, currency, rates) {
  const paid = new Map();
  const add = (from, to, amount) => paid.set(`${from}\n${to}`, (paid.get(`${from}\n${to}`) ?? 0) + amount);
  for (const record of unsettled) {
    if (record.type !== "payment") {
      continue;
    }
    const amount = convert(record.amount, record.currency, currency, rates);
    if (amount !== null) {
      add(record.fromId, record.toId, amount);
      add(record.toId, record.fromId, -amount);
    }
  }
  const owed = { ...balances };
  const refunds = [];
  for (const [pair, net] of paid) {
    const [payer, receiver] = pair.split("\n");
    const amount = roundMoney(Math.min(net, owed[payer] ?? 0));
    if (amount >= 0.01) {
      refunds.push({ from: receiver, to: payer, amount, refund: true });
      owed[payer] = roundMoney(owed[payer] - amount);
    }
  }
  return refunds;
}

export function cardTotal(amounts) {
  return roundMoney(Object.values(amounts).reduce((sum, amount) => sum + amount, 0));
}

export function isCurrencyCode(code) {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code);
}

const isAmount = (value) => Number.isFinite(value) && value >= 0;

// Why a record can't be saved, as a message key, or null if it's fine.
export function recordProblem(record, members) {
  const known = new Set(members.map((member) => member.id));
  if (!isRealDate(record.date)) {
    return "needDate";
  }
  if (!isCurrencyCode(record.currency)) {
    return "needCurrency";
  }
  if (record.type === "card") {
    const ids = Object.keys(record.amounts ?? {});
    if (ids.length < 2) {
      return "cardNeedTwo";
    }
    if (!ids.every((id) => known.has(id) && Number.isFinite(record.amounts[id]))) {
      return "badAmount";
    }
    return Math.abs(cardTotal(record.amounts)) < 0.005 ? null : "cardNotZero";
  }
  if (record.type === "bet") {
    if (!known.has(record.bettorId) || !known.has(record.holderId)) {
      return "betNeedPeople";
    }
    if (!(isAmount(record.stake) && record.stake > 0)) {
      return "needStake";
    }
    if (!isAmount(record.payout)) {
      return "needPayout";
    }
    if (record.payout < record.stake) {
      return "payoutBelowStake";
    }
    if (!BET_RESULTS.includes(record.result)) {
      return "needResult";
    }
    if (record.result === "cashout" && !isAmount(record.cashout)) {
      return "needCashout";
    }
    return null;
  }
  if (record.type === "split") {
    if (!known.has(record.payerId)) {
      return "splitNeedPayer";
    }
    if (!(isAmount(record.amount) && record.amount > 0)) {
      return "needAmount";
    }
    const people = Array.isArray(record.participantIds) ? record.participantIds : [];
    if (!people.length || new Set(people).size !== people.length || !people.every((id) => known.has(id))) {
      return "splitNeedPeople";
    }
    if (record.shares !== undefined) {
      return splitSharesProblem(record);
    }
    return null;
  }
  if (record.type === "payment") {
    if (!known.has(record.fromId) || !known.has(record.toId) || record.fromId === record.toId) {
      return "paymentNeedPeople";
    }
    return isAmount(record.amount) && record.amount > 0 ? null : "needAmount";
  }
  return "badType";
}

// For an AA split with an amount per person: everyone in the split has a
// share, and the shares add up exactly to the amount.
function splitSharesProblem(record) {
  const shares = record.shares;
  if (!shares || typeof shares !== "object" || Array.isArray(shares)) {
    return "splitNeedShares";
  }
  const ids = Object.keys(shares);
  if (ids.length !== record.participantIds.length || !record.participantIds.every((id) => id in shares)) {
    return "splitNeedShares";
  }
  if (!Object.values(shares).every(isAmount)) {
    return "splitNeedShares";
  }
  return splitSharesLeft(record) === 0 ? null : "splitSharesNotTotal";
}

// How much of an AA amount isn't given to anyone yet (negative when the
// shares add up to more than the amount). Shares that aren't numbers yet
// count as 0.
export function splitSharesLeft(record) {
  const given = Object.values(record.shares ?? {}).reduce((sum, share) => sum + (Number.isFinite(share) ? Math.round(share * 100) : 0), 0);
  return (Math.round(record.amount * 100) - given) / 100;
}

// Whether a member appears in any record, so deleting them would break it.
export function memberIsUsed(memberId, records) {
  return records.some((record) => {
    if (record.type === "card") {
      return memberId in record.amounts;
    }
    if (record.type === "bet") {
      return record.bettorId === memberId || record.holderId === memberId;
    }
    if (record.type === "payment") {
      return record.fromId === memberId || record.toId === memberId;
    }
    return record.payerId === memberId || record.participantIds.includes(memberId);
  });
}

// Reads a backup file. Returns { ok: true, book } or { ok: false, error }
// with a message key. Every record is checked, so a damaged file never
// replaces good data.
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "backupNotJson" };
  }
  if (!data || data.format !== BACKUP_FORMAT || !data.book) {
    return { ok: false, error: "backupWrongFormat" };
  }
  const { members, records, settings } = data.book;
  if (!Array.isArray(members) || !Array.isArray(records)) {
    return { ok: false, error: "backupDamaged" };
  }
  const membersOk = members.every((member) => typeof member?.id === "string" && typeof member.name === "string" && member.name.trim());
  const ids = new Set(members.map((member) => member?.id));
  if (!membersOk || ids.size !== members.length) {
    return { ok: false, error: "backupDamaged" };
  }
  const recordsOk = records.every(
    (record) =>
      typeof record?.id === "string" &&
      RECORD_TYPES.includes(record.type) &&
      (record.note === undefined || typeof record.note === "string") &&
      recordProblem(record, members) === null,
  );
  if (!recordsOk || new Set(records.map((record) => record.id)).size !== records.length) {
    return { ok: false, error: "backupDamaged" };
  }
  const book = emptyBook();
  book.members = members.map(({ id, name }) => ({ id, name: name.trim() }));
  book.records = records;
  // Only settings the page can use; anything else keeps the default.
  if (typeof settings?.lang === "string") {
    book.settings.lang = settings.lang;
  }
  if (isCurrencyCode(settings?.currency)) {
    book.settings.currency = settings.currency;
  }
  return { ok: true, book };
}

export function buildBackup(book, exportedAt = new Date()) {
  return {
    format: BACKUP_FORMAT,
    app: "TallyUp",
    exportedAt: exportedAt.toISOString(),
    book: { members: book.members, records: book.records, settings: book.settings },
  };
}

// Reads the saved book; anything unreadable starts a fresh one, and the
// unreadable text is returned so it can be kept rather than overwritten.
export function loadBook(storage) {
  const text = storage.getItem(STORAGE_KEY);
  if (text === null) {
    return { book: emptyBook(), savedText: null, unreadable: null };
  }
  try {
    const data = JSON.parse(text);
    const book = { ...emptyBook(), ...data, settings: { ...emptyBook().settings, ...(data.settings ?? {}) } };
    if (!Array.isArray(book.members) || !Array.isArray(book.records)) {
      throw new Error("not a book");
    }
    return { book, savedText: text, unreadable: null };
  } catch {
    return { book: emptyBook(), savedText: text, unreadable: text };
  }
}
