// Connects the page to the money rules in ledger.js.

import {
  buildBackup,
  cardTotal,
  isRealDate,
  loadBook,
  localDateKey,
  memberIsUsed,
  parseAmount,
  parseBackup,
  recordProblem,
  recordWinnings,
  roundMoney,
  settlementPlan,
  splitSharesLeft,
  STORAGE_KEY,
  sumByMember,
  betResult,
} from "./ledger.js";
import { decimalMark, getLang, LANGS, locale, setLang, t } from "./i18n.js";

const RATES_KEY = "tallyup.rates";
const RATES_URL = "https://api.frankfurter.dev/v1/latest?from=EUR";
// The currencies the exchange-rate service covers.
export const CURRENCIES = [
  "CNY", "USD", "EUR", "GBP", "JPY", "KRW", "HKD", "SGD", "AUD", "CAD", "CHF", "NZD", "THB", "MYR", "PHP",
  "IDR", "INR", "MXN", "BRL", "ZAR", "TRY", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "ISK", "ILS",
];

const view = document.getElementById("view");
const toast = document.getElementById("toast");
const banner = document.getElementById("banner");
const staleNotice = document.getElementById("stale");
const recordDialog = document.getElementById("record-dialog");
const recordForm = document.getElementById("record-form");
const recordFields = document.getElementById("record-fields");
const recordError = document.getElementById("record-error");
const renameDialog = document.getElementById("rename-dialog");
const impactDialog = document.getElementById("impact-dialog");
const renameInput = document.getElementById("rename-input");
const renameError = document.getElementById("rename-error");

let book;
// The exact text last saved, to notice changes made in another window.
let savedText = null;
let stale = false;
let rates = null;
let tab = "records";
let selectedDate = localDateKey(new Date());
// The state before the last delete, settle or restore, for Undo.
let undo = null;
let editingRecord = null;
let recordType = "card";
let renamingId = null;
let pendingRestore = null;
// What to do if the payment-impact preview is confirmed.
let pendingImpact = null;
let toastTimer = null;

start();

function start() {
  try {
    const loaded = loadBook(window.localStorage);
    book = loaded.book;
    savedText = loaded.savedText;
    if (loaded.unreadable !== null) {
      // Keep the unreadable text instead of overwriting it.
      window.localStorage.setItem(`tallyup.unreadable.${Date.now()}`, loaded.unreadable);
      showBanner(t("loadProblem"));
    }
  } catch {
    book = book ?? loadBook({ getItem: () => null }).book;
    showBanner(t("saveFailed"));
  }
  try {
    rates = JSON.parse(window.localStorage.getItem(RATES_KEY));
  } catch {
    // A broken copy of the rates is only a cache: fetch fresh ones instead.
    rates = null;
  }
  setLang(book.settings.lang);
  document.getElementById("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) {
      tab = button.dataset.tab;
      render();
      view.focus();
    }
  });
  document.getElementById("stale-reload").addEventListener("click", () => window.location.reload());
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && event.newValue !== savedText) {
      stale = true;
      render();
    }
  });
  recordForm.addEventListener("submit", saveRecordFromForm);
  recordForm.addEventListener("input", updateLivePreview);
  recordForm.addEventListener("change", updateLivePreview);
  // An error message goes away as soon as someone starts fixing it.
  recordForm.addEventListener("input", () => (recordError.hidden = true));
  renameInput.addEventListener("input", () => (renameError.hidden = true));
  document.getElementById("record-cancel").addEventListener("click", () => recordDialog.close());
  document.getElementById("rename-form").addEventListener("submit", saveRename);
  document.getElementById("rename-cancel").addEventListener("click", () => renameDialog.close());
  // Cancelling (or Esc) only closes the preview: nothing has been saved yet.
  document.getElementById("impact-cancel").addEventListener("click", () => impactDialog.close());
  document.getElementById("impact-confirm").addEventListener("click", () => {
    const confirmed = pendingImpact;
    impactDialog.close();
    confirmed?.();
  });
  impactDialog.addEventListener("close", () => (pendingImpact = null));
  render();
  if (needsRates()) {
    refreshRates({ quiet: true });
  }
  keepFilesForOffline();
  document.documentElement.dataset.appState = "ready";
}

// Lets the app open without internet (see sw.js). Only on a real web address:
// the test pages load the app from text, where there's nothing to install.
function keepFilesForOffline() {
  if (!("serviceWorker" in navigator) || !window.location.protocol.startsWith("http")) {
    return;
  }
  navigator.serviceWorker.register(new URL("sw.js", import.meta.url)).catch(() => {
    // The app still works online without it.
  });
}

// True when opened from the home screen icon rather than in the browser.
function isHomeScreenApp() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

// ---------- Saving ----------

// Saves the next version of the book. Refuses if another window changed it,
// and keeps the previous version for Undo when undoMessage is given.
function commit(nextBook, { message = null, undoMessage = null } = {}) {
  if (stale) {
    render();
    return false;
  }
  let current;
  try {
    current = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    showBanner(t("saveFailed"));
    return false;
  }
  if (current !== savedText) {
    stale = true;
    render();
    return false;
  }
  const text = JSON.stringify(nextBook);
  try {
    window.localStorage.setItem(STORAGE_KEY, text);
  } catch {
    showBanner(t("saveFailed"));
    showToast(t("saveFailed"));
    return false;
  }
  const previous = book;
  book = nextBook;
  savedText = text;
  banner.hidden = true;
  undo = undoMessage ? { message: undoMessage, book: previous } : null;
  render();
  if (message) {
    showToast(message);
  }
  // A record in another currency needs today's rates for the totals.
  if (needsRates()) {
    refreshRates({ quiet: true });
  }
  return true;
}

function withRecords(records) {
  return { ...book, records };
}

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------- Small helpers ----------

// Builds an element. Text is always added as text, never as HTML, so names
// and notes can't change the page.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === "class") {
      element.className = value;
    } else if (key === "text") {
      element.textContent = value;
    } else if (key.startsWith("on")) {
      element.addEventListener(key.slice(2), value);
    } else if (key === "value" || key === "checked") {
      element[key] = value;
    } else {
      element.setAttribute(key, value === true ? "" : value);
    }
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

function money(amount, currency = book.settings.currency) {
  return new Intl.NumberFormat(locale(), { style: "currency", currency }).format(amount);
}

function signedMoney(amount, currency = book.settings.currency) {
  return new Intl.NumberFormat(locale(), { style: "currency", currency, signDisplay: "exceptZero" }).format(amount);
}

// An amount as it goes back into a form field, in this language's format: 12,5 in Spanish.
function amountForInput(amount) {
  return amount === undefined ? "" : String(amount).replace(".", decimalMark());
}

// What someone typed as an amount, read in this language's format.
function readAmount(text) {
  return parseAmount(text, decimalMark());
}

function amountClass(amount) {
  if (amount > 0.004) {
    return "amount win";
  }
  return amount < -0.004 ? "amount loss" : "amount";
}

function currencyName(code) {
  try {
    return `${code} · ${new Intl.DisplayNames([locale()], { type: "currency" }).of(code)}`;
  } catch {
    return code;
  }
}

function longDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric", weekday: "short" });
}

function nameOf(id) {
  return book.members.find((member) => member.id === id)?.name ?? "?";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3000);
}

function showBanner(message) {
  banner.textContent = message;
  banner.hidden = false;
}

function shiftDate(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return localDateKey(new Date(year, month - 1, day + days));
}

// ---------- Exchange rates ----------

function needsRates() {
  return book.records.some((record) => record.currency !== book.settings.currency) && !ratesAreFresh();
}

function ratesAreFresh() {
  return rates?.fetchedOn === localDateKey(new Date());
}

async function refreshRates({ quiet = false } = {}) {
  if (!quiet) {
    showToast(t("ratesUpdating"));
  }
  try {
    const response = await fetch(RATES_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data?.base !== "EUR" || typeof data.rates !== "object") {
      throw new Error("unexpected reply");
    }
    rates = { base: data.base, date: data.date, rates: data.rates, fetchedOn: localDateKey(new Date()) };
    try {
      window.localStorage.setItem(RATES_KEY, JSON.stringify(rates));
    } catch {
      // The rates still work for this visit.
    }
    render();
    if (!quiet) {
      showToast(t("ratesOk"));
    }
  } catch {
    if (!quiet) {
      showToast(t("ratesFailed"));
    }
  }
}

// ---------- Drawing ----------

function render() {
  setLang(book.settings.lang);
  document.title = t("appName");
  document.getElementById("app-name").textContent = t("appName");
  document.getElementById("tagline").textContent = t("tagline");
  for (const button of document.querySelectorAll("#tabs [data-tab]")) {
    const key = { records: "tabRecords", settle: "tabSettle", people: "tabPeople", more: "tabMore" }[button.dataset.tab];
    button.textContent = t(key);
    if (button.dataset.tab === tab) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  document.getElementById("tabs").setAttribute("aria-label", t("appName"));
  staleNotice.hidden = !stale;
  document.getElementById("stale-text").textContent = t("staleNotice");
  document.getElementById("stale-reload").textContent = t("reload");
  const content = { records: renderRecords, settle: renderSettle, people: renderPeople, more: renderMore }[tab]();
  view.replaceChildren(...[renderUndo(), ...content].filter(Boolean));
}

function renderUndo() {
  if (!undo) {
    return null;
  }
  return h(
    "div",
    { class: "card undo-bar", role: "status" },
    h("p", { text: undo.message }),
    h("button", { type: "button", class: "button-secondary", id: "undo-button", text: t("undo"), onclick: undoLast }),
  );
}

function undoLast() {
  const previous = undo.book;
  undo = null;
  commit({ ...previous, settings: book.settings }, { message: t("undone") });
  view.focus();
}

// ----- Records tab -----

function renderRecords() {
  const dayRecords = book.records.filter((record) => record.date === selectedDate);
  const parts = [];
  const dateInput = h("input", {
    type: "date",
    id: "day-input",
    value: selectedDate,
    "aria-label": t("date"),
    onchange: (event) => {
      if (isRealDate(event.target.value)) {
        selectedDate = event.target.value;
        render();
        document.getElementById("day-input")?.focus();
      }
    },
  });
  parts.push(
    h(
      "section",
      { class: "card", "aria-labelledby": "day-heading" },
      h("h2", { id: "day-heading", text: longDate(selectedDate) }),
      h(
        "div",
        { class: "date-row" },
        h("button", { type: "button", class: "button-secondary", "aria-label": t("prevDay"), text: "‹", onclick: () => moveDay(-1) }),
        dateInput,
        h("button", { type: "button", class: "button-secondary", "aria-label": t("nextDay"), text: "›", onclick: () => moveDay(1) }),
      ),
      selectedDate !== localDateKey(new Date())
        ? h("button", { type: "button", class: "button-secondary today-button", text: t("today"), onclick: () => setDay(localDateKey(new Date())) })
        : null,
    ),
  );

  if (book.members.length < 2) {
    parts.push(
      h(
        "section",
        { class: "card" },
        h("p", { text: t("needMembersFirst") }),
        h("button", { type: "button", class: "button-primary", text: t("goToPeople"), onclick: () => goToTab("people") }),
      ),
    );
    // On iPhone the home screen app starts empty even if Safari has records,
    // so say where they are instead of letting it look like they're lost.
    if (isHomeScreenApp() && book.members.length === 0 && book.records.length === 0) {
      parts.push(
        h(
          "section",
          { class: "card", id: "home-empty-hint" },
          h("p", { text: t("homeEmptyHint") }),
          h("button", { type: "button", class: "button-secondary", text: t("goRestore"), onclick: goToRestore }),
        ),
      );
    }
  } else {
    parts.push(
      h(
        "div",
        { class: "add-buttons card" },
        h("button", { type: "button", class: "button-primary", id: "add-card", text: t("addCard"), onclick: () => openRecordDialog("card") }),
        h("button", { type: "button", class: "button-primary", id: "add-bet", text: t("addBet"), onclick: () => openRecordDialog("bet") }),
        h("button", { type: "button", class: "button-primary", id: "add-split", text: t("addSplit"), onclick: () => openRecordDialog("split") }),
      ),
    );
  }

  const { totals, missing } = sumByMember(dayRecords, recordWinnings, book.settings.currency, rates);
  parts.push(
    h(
      "section",
      { class: "card", "aria-labelledby": "day-results-heading" },
      h("h2", { id: "day-results-heading", text: t("dayResults") }),
      amountList(totals, t("dayResultsEmpty")),
      missingNote(missing),
    ),
  );

  parts.push(
    dayRecords.length
      ? h("ul", { class: "record-list", "aria-label": t("tabRecords") }, dayRecords.map(renderRecord))
      : h("p", { class: "muted", text: t("noRecordsDay") }),
  );

  const days = [...new Set(book.records.map((record) => record.date))].sort().reverse();
  if (days.length) {
    parts.push(
      h(
        "section",
        { class: "card", "aria-labelledby": "days-heading", style: "margin-top:14px" },
        h("h2", { id: "days-heading", text: t("allDays") }),
        h(
          "ul",
          { class: "day-list" },
          days.map((day) =>
            h(
              "li",
              {},
              h(
                "button",
                { type: "button", "aria-current": day === selectedDate ? "date" : null, onclick: () => setDay(day) },
                h("span", { text: longDate(day) }),
                h("span", { class: "muted", text: t("recordCount", { n: book.records.filter((record) => record.date === day).length }) }),
              ),
            ),
          ),
        ),
      ),
    );
  }
  return parts;
}

function moveDay(days) {
  setDay(shiftDate(selectedDate, days));
}

function setDay(day) {
  selectedDate = day;
  render();
  document.getElementById("day-heading")?.scrollIntoView({ block: "nearest" });
}

function goToTab(name) {
  tab = name;
  render();
  view.focus();
}

function goToRestore() {
  goToTab("more");
  const restoreInput = document.getElementById("restore-input");
  restoreInput.scrollIntoView({ block: "center" });
  restoreInput.focus();
}

// A list of names with signed amounts in the main currency, biggest win first.
function amountList(totals, emptyText) {
  const entries = Object.entries(totals).filter(([, amount]) => Math.abs(amount) >= 0.005);
  if (!entries.length) {
    return h("p", { class: "muted", text: emptyText });
  }
  entries.sort((a, b) => b[1] - a[1]);
  return h(
    "ul",
    { class: "amount-list" },
    entries.map(([id, amount]) => h("li", {}, h("span", { class: "name", text: nameOf(id) }), h("span", { class: amountClass(amount), text: signedMoney(amount) }))),
  );
}

function missingNote(missing) {
  return missing.length ? h("p", { class: "hint", text: t("missingRates", { list: missing.join(", ") }) }) : null;
}

function renderRecord(record) {
  const typeKey = { card: "typeCard", bet: "typeBet", split: "typeSplit", payment: "typePayment" }[record.type];
  const body = [];
  if (record.type === "card") {
    body.push(
      h(
        "ul",
        { class: "amount-list" },
        Object.entries(record.amounts)
          .sort((a, b) => b[1] - a[1])
          .map(([id, amount]) => h("li", {}, h("span", { class: "name", text: nameOf(id) }), h("span", { class: amountClass(amount), text: signedMoney(amount, record.currency) }))),
      ),
    );
  } else if (record.type === "bet") {
    body.push(
      h("p", {
        text: t("betSummary", {
          bettor: nameOf(record.bettorId),
          holder: nameOf(record.holderId),
          stake: money(record.stake, record.currency),
          payout: money(record.payout, record.currency),
        }),
      }),
    );
    const result = betResult(record);
    body.push(h("p", {}, h("span", { text: `${resultText(record)} · ` }), h("span", { class: amountClass(result), text: signedMoney(result, record.currency) })));
    body.push(h("p", { class: "transfer", text: betTransferText(record) }));
  } else if (record.type === "payment") {
    body.push(h("p", { text: t("paymentSummary", { from: nameOf(record.fromId), to: nameOf(record.toId), amount: money(record.amount, record.currency) }) }));
  } else if (record.shares) {
    body.push(h("p", { text: t("splitCustomSummary", { payer: nameOf(record.payerId), amount: money(record.amount, record.currency) }) }));
    body.push(
      h(
        "ul",
        { class: "amount-list" },
        Object.entries(record.shares)
          .sort((a, b) => b[1] - a[1])
          .map(([id, share]) => h("li", {}, h("span", { class: "name", text: nameOf(id) }), h("span", { class: "amount", text: money(share, record.currency) }))),
      ),
    );
  } else {
    body.push(
      h("p", {
        text: t("splitSummary", {
          payer: nameOf(record.payerId),
          amount: money(record.amount, record.currency),
          n: record.participantIds.length,
          share: money(roundMoney(record.amount / record.participantIds.length), record.currency),
        }),
      }),
    );
    body.push(h("p", { class: "muted", text: record.participantIds.map(nameOf).join(t("listSeparator")) }));
  }
  if (record.note) {
    body.push(h("p", { class: "muted", text: `${t("note")}: ${record.note}` }));
  }
  return h(
    "li",
    { class: "record", "data-record-id": record.id },
    h(
      "div",
      { class: "record-head" },
      h("span", { class: "badge badge-type", text: t(typeKey) }),
      record.currency !== book.settings.currency ? h("span", { class: "badge badge-muted", text: record.currency }) : null,
      record.settled ? h("span", { class: "badge badge-muted", text: t("settledBadge") }) : null,
    ),
    body,
    h(
      "div",
      { class: "button-row" },
      // A payment is made from the settle page, so it can be deleted but not edited.
      record.type === "payment"
        ? null
        : h("button", { type: "button", class: "button-secondary", text: t("edit"), "aria-label": `${t("edit")} ${t(typeKey)}`, onclick: () => openRecordDialog(record.type, record) }),
      h("button", { type: "button", class: "button-secondary button-danger", text: t("delete"), "aria-label": `${t("delete")} ${t(typeKey)}`, onclick: () => deleteRecord(record) }),
    ),
  );
}

function resultText(record) {
  if (record.result === "win") {
    return t("resultWinShort");
  }
  if (record.result === "lose") {
    return t("resultLoseShort");
  }
  return t("resultCashoutShort", { amount: money(record.cashout, record.currency) });
}

function betTransferText(record) {
  const result = betResult(record);
  if (record.bettorId === record.holderId) {
    return t("ownAccount", { result: signedMoney(result, record.currency) });
  }
  if (result > 0) {
    return t("pays", { from: nameOf(record.holderId), to: nameOf(record.bettorId), amount: money(result, record.currency) });
  }
  if (result < 0) {
    return t("pays", { from: nameOf(record.bettorId), to: nameOf(record.holderId), amount: money(-result, record.currency) });
  }
  return t("even");
}

function deleteRecord(record) {
  const records = book.records.filter((other) => other.id !== record.id);
  const finish = () => {
    if (commit(withRecords(records), { undoMessage: t("deleted") })) {
      document.getElementById("undo-button")?.focus();
    }
  };
  // The preview asks instead of the plain question when payments are affected.
  if (showPaymentImpact(record, null, records, finish)) {
    return;
  }
  if (window.confirm(t("deleteConfirm"))) {
    finish();
  }
}

// ----- Payment impact preview -----

// Payments aren't tied to a record: each one counts against the two people's
// overall balances. So when an AA that involves someone with a recorded
// payment is edited or deleted, the payments stay and the balances move; this
// shows how, before anything is saved. Returns false (and shows nothing) when
// no recorded payment is involved or nobody's balance changes.
function showPaymentImpact(oldRecord, newRecord, nextRecords, onConfirm) {
  if (oldRecord.type !== "split") {
    return false;
  }
  const people = new Set([oldRecord, newRecord].filter(Boolean).flatMap((record) => [record.payerId, ...record.participantIds]));
  const touchesPayment = book.records.some((record) => record.type === "payment" && !record.settled && (people.has(record.fromId) || people.has(record.toId)));
  if (!touchesPayment) {
    return false;
  }
  const currency = book.settings.currency;
  const before = settlementPlan(book.records, currency, rates);
  const after = settlementPlan(nextRecords, currency, rates);
  const ids = book.members.map((member) => member.id).filter((id) => (before.balances[id] ?? 0) !== 0 || (after.balances[id] ?? 0) !== 0 || people.has(id));
  if (ids.every((id) => Math.abs((before.balances[id] ?? 0) - (after.balances[id] ?? 0)) < 0.005)) {
    return false;
  }
  document.getElementById("impact-title").textContent = t(newRecord ? "impactTitleEdit" : "impactTitleDelete");
  document.getElementById("impact-confirm").textContent = t(newRecord ? "impactConfirmEdit" : "impactConfirmDelete");
  document.getElementById("impact-cancel").textContent = t("cancel");
  const hasRefund = after.transfers.some((transfer) => transfer.refund);
  // replaceChildren would print an empty part as "null", so those are left out.
  const parts = [
    h("p", { class: "hint", text: t("impactHelp") }),
    h(
      "ul",
      { class: "impact-list", id: "impact-people" },
      ids.map((id) => {
        const from = balanceText(before.balances[id] ?? 0);
        const to = balanceText(after.balances[id] ?? 0);
        return h("li", {}, h("span", { class: "name", text: nameOf(id) }), h("span", { text: from === to ? t("impactSame", { status: to }) : `${from} → ${to}` }));
      }),
    ),
    h("h3", { text: t("impactPlanTitle") }),
    missingNote([...new Set([...before.missing, ...after.missing])]),
    hasRefund ? h("p", { class: "hint", text: t("impactRefundNote") }) : null,
    after.transfers.length
      ? h("ul", { class: "impact-list", id: "impact-plan" }, after.transfers.map((transfer) => h("li", { class: transfer.refund ? "refund" : null, text: transferText(transfer) })))
      : h("p", { text: t("allSettled") }),
  ];
  document.getElementById("impact-body").replaceChildren(...parts.filter(Boolean));
  pendingImpact = onConfirm;
  impactDialog.showModal();
  return true;
}

function balanceText(amount) {
  if (amount >= 0.005) {
    return t("isOwed", { amount: money(amount) });
  }
  return amount <= -0.005 ? t("owes", { amount: money(-amount) }) : t("even");
}

// "A 转给 B ¥30.00", or "A 退给 B ¥10.00" for a refund.
function transferText(transfer) {
  return t(transfer.refund ? "refunds" : "pays", { from: nameOf(transfer.from), to: nameOf(transfer.to), amount: money(transfer.amount) });
}

// ----- Record form -----

function openRecordDialog(type, existing = null) {
  recordType = type;
  editingRecord = existing;
  const titleKey = existing ? "editRecord" : { card: "newCard", bet: "newBet", split: "newSplit" }[type];
  document.getElementById("record-dialog-title").textContent = t(titleKey);
  document.getElementById("record-save").textContent = t("save");
  document.getElementById("record-cancel").textContent = t("cancel");
  recordError.hidden = true;
  const date = existing?.date ?? selectedDate;
  const currency = existing?.currency ?? book.settings.currency;
  const fields = [
    field("date", t("date"), h("input", { type: "date", id: "f-date", name: "date", value: date, required: true })),
    field("currency", t("currency"), currencySelect("f-currency", "currency", currency)),
  ];
  if (type === "card") {
    fields.push(h("p", { class: "hint", text: t("cardHint") }));
    for (const member of book.members) {
      const amount = existing?.amounts?.[member.id];
      const lost = amount < 0;
      fields.push(
        h(
          "div",
          { class: "player-row", "data-member": member.id },
          h("span", { class: "player-name", id: `p-${member.id}`, text: member.name }),
          h(
            "div",
            { class: "choice-group", role: "radiogroup", "aria-labelledby": `p-${member.id}` },
            chip("radio", `side-${member.id}`, "won", t("won"), !lost),
            chip("radio", `side-${member.id}`, "lost", t("lost"), lost),
          ),
          h("input", {
            name: `amount-${member.id}`,
            inputmode: "decimal",
            autocomplete: "off",
            "aria-labelledby": `p-${member.id}`,
            placeholder: "0",
            value: amount === undefined ? "" : amountForInput(Math.abs(amount)),
          }),
        ),
      );
    }
  } else if (type === "bet") {
    const lastBet = [...book.records].reverse().find((record) => record.type === "bet");
    fields.push(
      field("bettor", t("bettor"), memberSelect("f-bettor", "bettor", existing?.bettorId ?? "")),
      field("holder", t("holder"), memberSelect("f-holder", "holder", existing?.holderId ?? lastBet?.holderId ?? "")),
      field("stake", t("stake"), h("input", { id: "f-stake", name: "stake", inputmode: "decimal", autocomplete: "off", value: amountForInput(existing?.stake) })),
      field("payout", t("payout"), h("input", { id: "f-payout", name: "payout", inputmode: "decimal", autocomplete: "off", value: amountForInput(existing?.payout) })),
      h(
        "fieldset",
        { class: "choice-group" },
        h("legend", { text: t("result") }),
        chip("radio", "result", "win", t("resultWin"), existing?.result === "win"),
        chip("radio", "result", "lose", t("resultLose"), existing?.result === "lose"),
        chip("radio", "result", "cashout", t("resultCashout"), existing?.result === "cashout"),
      ),
      h(
        "div",
        { id: "cashout-field", hidden: existing?.result !== "cashout" },
        field("cashout", t("cashoutAmount"), h("input", { id: "f-cashout", name: "cashout", inputmode: "decimal", autocomplete: "off", value: amountForInput(existing?.cashout) })),
      ),
    );
  } else {
    const included = new Set(existing?.participantIds ?? book.members.map((member) => member.id));
    fields.push(
      field("payer", t("payer"), memberSelect("f-payer", "payer", existing?.payerId ?? "")),
      field("amount", t("amount"), h("input", { id: "f-amount", name: "amount", inputmode: "decimal", autocomplete: "off", value: amountForInput(existing?.amount) })),
      h(
        "fieldset",
        { class: "choice-group" },
        h("legend", { text: t("participants") }),
        book.members.map((member) => chip("checkbox", "participant", member.id, member.name, included.has(member.id))),
      ),
      h(
        "fieldset",
        { class: "choice-group" },
        h("legend", { text: t("splitHow") }),
        chip("radio", "splitMode", "equal", t("splitEqual"), !existing?.shares),
        chip("radio", "splitMode", "custom", t("splitCustom"), Boolean(existing?.shares)),
      ),
      // One amount box per member; only the ticked people's boxes show.
      h(
        "div",
        { id: "share-fields", hidden: !existing?.shares },
        book.members.map((member) =>
          h(
            "div",
            { class: "share-row", "data-member": member.id, hidden: !included.has(member.id) },
            h("label", { for: `share-${member.id}`, text: member.name }),
            h("input", {
              id: `share-${member.id}`,
              name: `share-${member.id}`,
              inputmode: "decimal",
              autocomplete: "off",
              placeholder: "0",
              value: amountForInput(existing?.shares?.[member.id]),
            }),
          ),
        ),
      ),
    );
  }
  fields.push(
    h("p", { id: "live-note", class: "live-note", "aria-live": "polite" }),
    field("note", t("noteOptional"), h("input", { id: "f-note", name: "note", autocomplete: "off", maxlength: "200", value: existing?.note ?? "" })),
  );
  recordFields.replaceChildren(...fields);
  updateLivePreview();
  recordDialog.showModal();
}

function field(name, label, control) {
  return h("div", {}, h("label", { for: control.id, text: label }), control);
}

function chip(type, name, value, label, checked) {
  return h("label", { class: "chip" }, h("input", { type, name, value, checked }), h("span", { text: label }));
}

function memberSelect(id, name, selected) {
  return h(
    "select",
    { id, name },
    h("option", { value: "", text: t("choose") }),
    book.members.map((member) => h("option", { value: member.id, text: member.name, selected: member.id === selected })),
  );
}

function currencySelect(id, name, selected) {
  const codes = CURRENCIES.includes(selected) ? CURRENCIES : [selected, ...CURRENCIES];
  return h("select", { id, name }, codes.map((code) => h("option", { value: code, text: currencyName(code), selected: code === selected })));
}

// Reads the form into a record. Amounts that aren't numbers become NaN, so
// recordProblem reports them.
function recordFromForm() {
  const data = new FormData(recordForm);
  const record = {
    id: editingRecord?.id ?? createId(),
    type: recordType,
    date: data.get("date"),
    currency: data.get("currency"),
    settled: editingRecord?.settled ?? false,
  };
  const note = String(data.get("note") ?? "").trim();
  if (note) {
    record.note = note;
  }
  if (recordType === "card") {
    record.amounts = {};
    for (const member of book.members) {
      const text = String(data.get(`amount-${member.id}`) ?? "").trim();
      if (text === "") {
        continue;
      }
      const amount = readAmount(text);
      record.amounts[member.id] = data.get(`side-${member.id}`) === "lost" ? -amount : amount;
    }
  } else if (recordType === "bet") {
    record.bettorId = data.get("bettor");
    record.holderId = data.get("holder");
    record.stake = readAmount(data.get("stake"));
    record.payout = readAmount(data.get("payout"));
    record.result = data.get("result");
    if (record.result === "cashout") {
      record.cashout = readAmount(data.get("cashout"));
    }
  } else {
    record.payerId = data.get("payer");
    record.amount = readAmount(data.get("amount"));
    record.participantIds = data.getAll("participant");
    if (data.get("splitMode") === "custom") {
      // A box left empty becomes NaN, which recordProblem reports.
      record.shares = Object.fromEntries(
        record.participantIds.map((id) => {
          const text = String(data.get(`share-${id}`) ?? "").trim();
          return [id, text === "" ? NaN : readAmount(text)];
        }),
      );
    }
  }
  return record;
}

// The line under the form that says what the record means before saving.
function updateLivePreview() {
  const note = document.getElementById("live-note");
  if (!note) {
    return;
  }
  const record = recordFromForm();
  note.classList.remove("is-off");
  if (recordType === "card") {
    const amounts = Object.values(record.amounts).filter(Number.isFinite);
    const total = cardTotal(Object.fromEntries(amounts.map((amount, index) => [index, amount])));
    if (amounts.length < 2) {
      note.textContent = "";
    } else if (Math.abs(total) < 0.005) {
      note.textContent = t("cardTotalOk");
    } else {
      note.classList.add("is-off");
      note.textContent = t("cardTotalOff", { amount: signedMoney(total, record.currency) });
    }
  } else if (recordType === "bet") {
    document.getElementById("cashout-field").hidden = record.result !== "cashout";
    const ready = record.bettorId && record.holderId && record.stake > 0 && record.payout >= record.stake && record.result && (record.result !== "cashout" || record.cashout >= 0);
    note.textContent = ready ? `${t("preview")}${betTransferText(record)}` : "";
  } else if (record.shares) {
    updateShareFields(record);
    const left = splitSharesLeft(record);
    if (!(record.amount > 0) || !record.participantIds.length) {
      note.textContent = "";
    } else if (left > 0) {
      note.classList.add("is-off");
      note.textContent = t("splitSharesLeft", { amount: money(left, record.currency) });
    } else if (left < 0) {
      note.classList.add("is-off");
      note.textContent = t("splitSharesOver", { amount: money(-left, record.currency) });
    } else if (!Object.values(record.shares).every(Number.isFinite)) {
      note.classList.add("is-off");
      note.textContent = t("splitNeedShares");
    } else {
      note.textContent = `${t("preview")}${t("splitCustomSummary", { payer: record.payerId ? nameOf(record.payerId) : "?", amount: money(record.amount, record.currency) })}`;
    }
  } else {
    updateShareFields(record);
    const ready = record.amount > 0 && record.participantIds.length > 0;
    note.textContent = ready
      ? `${t("preview")}${t("splitSummary", {
          payer: record.payerId ? nameOf(record.payerId) : "?",
          amount: money(record.amount, record.currency),
          n: record.participantIds.length,
          share: money(roundMoney(record.amount / record.participantIds.length), record.currency),
        })}`
      : "";
  }
}

// Shows the amount boxes only when splitting by amount, and only for the
// people ticked.
function updateShareFields(record) {
  document.getElementById("share-fields").hidden = !record.shares;
  for (const row of document.querySelectorAll(".share-row")) {
    row.hidden = !record.participantIds.includes(row.dataset.member);
  }
}

function saveRecordFromForm(event) {
  event.preventDefault();
  const record = recordFromForm();
  let problem = recordProblem(record, book.members);
  if (recordType === "card" && Object.values(record.amounts).some((amount) => !Number.isFinite(amount))) {
    problem = "badAmount";
  }
  if (problem) {
    recordError.textContent = t(problem);
    recordError.hidden = false;
    return;
  }
  const records = editingRecord
    ? book.records.map((other) => (other.id === record.id ? record : other))
    : [...book.records, record];
  if (editingRecord && showPaymentImpact(editingRecord, record, records, () => finishSave(record, records))) {
    return;
  }
  finishSave(record, records);
}

function finishSave(record, records) {
  if (commit(withRecords(records), { message: t("saved") })) {
    selectedDate = record.date;
    recordDialog.close();
    tab = "records";
    render();
    document.querySelector(`[data-record-id="${CSS.escape(record.id)}"] button`)?.focus();
  } else {
    // Keep the form open so nothing typed is lost, and say why.
    recordError.textContent = stale ? t("staleNotice") : t("saveFailed");
    recordError.hidden = false;
  }
}

// ----- Settle tab -----

function renderSettle() {
  const currency = book.settings.currency;
  const unsettled = book.records.filter((record) => !record.settled);
  const { balances, transfers, missing } = settlementPlan(book.records, currency, rates);
  const parts = [
    h(
      "section",
      { class: "card", "aria-labelledby": "settle-heading" },
      h("h2", { id: "settle-heading", text: t("settleTitle") }),
      h("p", { class: "hint", text: t("settleNote", { currency }) }),
      missingNote(missing),
      transfers.length ? h("p", { class: "hint", text: t("paidHint") }) : null,
      transfers.length
        ? h(
            "ul",
            { class: "transfer-list", id: "transfer-list" },
            transfers.map((transfer) => {
              const amount = money(transfer.amount);
              const names = { from: nameOf(transfer.from), to: nameOf(transfer.to) };
              return h(
                "li",
                { class: transfer.refund ? "refund" : null },
                h("span", { class: "name", text: t(transfer.refund ? "refundLine" : "payLine", names) }),
                h("span", { class: "amount", text: amount }),
                h("button", {
                  type: "button",
                  class: "button-secondary paid-button",
                  text: t("paidButton"),
                  "aria-label": t("paidButtonLabel", { ...names, amount }),
                  onclick: () => markPaid(transfer),
                }),
              );
            }),
          )
        : h("p", { text: t("allSettled") }),
      h(
        "div",
        { class: "form-actions" },
        h("button", { type: "button", class: "button-primary", id: "share-button", text: t("share"), onclick: () => shareSettlement(transfers) }),
        unsettled.length ? h("button", { type: "button", class: "button-secondary", id: "settle-all", text: t("markSettled"), onclick: () => markAllSettled(missing) }) : null,
      ),
      h("p", { class: "form-error", id: "settle-error", role: "alert", hidden: true }),
      h("div", { id: "share-fallback" }),
    ),
  ];
  if (book.members.length) {
    parts.push(
      h(
        "section",
        { class: "card", "aria-labelledby": "balances-heading" },
        h("h2", { id: "balances-heading", text: t("balancesTitle") }),
        h(
          "ul",
          { class: "amount-list" },
          book.members.map((member) => {
            const amount = balances[member.id] ?? 0;
            return h("li", {}, h("span", { class: "name", text: member.name }), h("span", { class: amountClass(amount), text: balanceText(amount) }));
          }),
        ),
      ),
    );
    const { totals, missing: missingTotal } = sumByMember(book.records, recordWinnings, currency, rates);
    parts.push(
      h(
        "section",
        { class: "card", "aria-labelledby": "totals-heading" },
        h("h2", { id: "totals-heading", text: t("totalResults") }),
        amountList(totals, t("dayResultsEmpty")),
        missingNote(missingTotal),
      ),
    );
  }
  return parts;
}

function settlementText(transfers) {
  const lines = [t("shareHeading", { date: longDate(localDateKey(new Date())) })];
  if (!transfers.length) {
    lines.push(t("shareNothing"));
  }
  for (const transfer of transfers) {
    lines.push(transferText(transfer));
  }
  return lines.join("\n");
}

async function shareSettlement(transfers) {
  const text = settlementText(transfers);
  if (navigator.share && /Mobi|iPhone|Android/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ text });
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("copied"));
  } catch {
    // Clipboard blocked: show the text to copy by hand.
    const area = h("textarea", { class: "share-text", readonly: true, "aria-label": t("copyThis"), value: text });
    document.getElementById("share-fallback").replaceChildren(h("p", { class: "hint", text: t("copyThis") }), area);
    area.focus();
    area.select();
  }
}

// missing: currencies with no rate yet. Their records aren't in the transfers,
// so settling now would drop what they owe.
// Records one transfer from the settle page as paid, as a payment record dated
// today in the main currency, so only that line goes away.
function markPaid(transfer) {
  const payment = {
    id: createId(),
    type: "payment",
    date: localDateKey(new Date()),
    currency: book.settings.currency,
    settled: false,
    fromId: transfer.from,
    toId: transfer.to,
    amount: transfer.amount,
  };
  if (commit(withRecords([...book.records, payment]), { undoMessage: t("paymentSaved") })) {
    document.getElementById("undo-button")?.focus();
  }
}

function markAllSettled(missing) {
  if (missing.length) {
    const error = document.getElementById("settle-error");
    error.textContent = t("settleNeedsRates");
    error.hidden = false;
    return;
  }
  if (!window.confirm(t("markSettledConfirm"))) {
    return;
  }
  const settledOn = localDateKey(new Date());
  const records = book.records.map((record) => (record.settled ? record : { ...record, settled: true, settledOn }));
  if (commit(withRecords(records), { undoMessage: t("markedSettled") })) {
    document.getElementById("undo-button")?.focus();
  }
}

// ----- People tab -----

function renderPeople() {
  const error = h("p", { class: "form-error", id: "member-error", role: "alert", hidden: true });
  const input = h("input", {
    id: "member-input",
    autocomplete: "off",
    maxlength: "40",
    placeholder: t("memberPlaceholder"),
    oninput: () => (error.hidden = true),
  });
  const form = h(
    "form",
    { id: "member-form", novalidate: true, onsubmit: (event) => addMember(event, input, error) },
    h("label", { for: "member-input", text: t("memberName") }),
    h("div", { class: "add-member" }, input, h("button", { type: "submit", class: "button-primary", text: t("addMember") })),
    error,
  );
  const { totals } = sumByMember(book.records, recordWinnings, book.settings.currency, rates);
  const list = book.members.length
    ? h(
        "ul",
        { class: "member-list" },
        book.members.map((member) => {
          const count = book.records.filter((record) => memberIsUsed(member.id, [record])).length;
          const total = totals[member.id] ?? 0;
          return h(
            "li",
            { class: "card member", "data-member-id": member.id },
            h(
              "div",
              {},
              h("div", { class: "member-name", text: member.name }),
              h("div", { class: "muted" }, h("span", { text: `${t("recordsOf", { n: count })} · ${t("totalLabel")} ` }), h("span", { class: amountClass(total), text: signedMoney(total) })),
            ),
            h(
              "div",
              { class: "button-row" },
              h("button", { type: "button", class: "button-secondary", text: t("rename"), "aria-label": `${t("rename")} ${member.name}`, onclick: () => openRename(member) }),
              h("button", { type: "button", class: "button-secondary button-danger", text: t("delete"), "aria-label": `${t("delete")} ${member.name}`, onclick: () => deleteMember(member) }),
            ),
          );
        }),
      )
    : h("p", { class: "muted", text: t("noMembers") });
  return [h("section", { class: "card", "aria-labelledby": "people-heading" }, h("h2", { id: "people-heading", text: t("peopleTitle") }), form), list];
}

function nameProblem(name, exceptId = null) {
  if (!name) {
    return t("nameEmpty");
  }
  const taken = book.members.some((member) => member.id !== exceptId && member.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  return taken ? t("nameTaken") : null;
}

function addMember(event, input, error) {
  event.preventDefault();
  const name = input.value.trim();
  const problem = nameProblem(name);
  if (problem) {
    error.textContent = problem;
    error.hidden = false;
    input.focus();
    return;
  }
  if (commit({ ...book, members: [...book.members, { id: createId(), name }] }, { message: t("memberAdded", { name }) })) {
    document.getElementById("member-input")?.focus();
  }
}

function openRename(member) {
  renamingId = member.id;
  document.getElementById("rename-title").textContent = t("renameTitle");
  document.getElementById("rename-label").textContent = t("memberName");
  document.getElementById("rename-save").textContent = t("save");
  document.getElementById("rename-cancel").textContent = t("cancel");
  renameInput.value = member.name;
  renameError.hidden = true;
  renameDialog.showModal();
}

function saveRename(event) {
  event.preventDefault();
  const name = renameInput.value.trim();
  const problem = nameProblem(name, renamingId);
  if (problem) {
    renameError.textContent = problem;
    renameError.hidden = false;
    renameInput.focus();
    return;
  }
  const members = book.members.map((member) => (member.id === renamingId ? { ...member, name } : member));
  if (commit({ ...book, members }, { message: t("saved") })) {
    renameDialog.close();
    document.querySelector(`[data-member-id="${CSS.escape(renamingId)}"] button`)?.focus();
  } else {
    renameError.textContent = stale ? t("staleNotice") : t("saveFailed");
    renameError.hidden = false;
  }
}

function deleteMember(member) {
  const error = document.getElementById("member-error");
  if (memberIsUsed(member.id, book.records)) {
    error.textContent = t("cantDelete", { name: member.name });
    error.hidden = false;
    return;
  }
  if (!window.confirm(t("memberDeleteConfirm", { name: member.name }))) {
    return;
  }
  if (commit({ ...book, members: book.members.filter((other) => other.id !== member.id) }, { undoMessage: t("deleted") })) {
    document.getElementById("undo-button")?.focus();
  }
}

// ----- More tab -----

function renderMore() {
  const langSelect = h(
    "select",
    { id: "lang-select", onchange: (event) => changeSetting({ lang: event.target.value }, "lang-select") },
    Object.entries(LANGS).map(([code, name]) => h("option", { value: code, text: name, selected: code === getLang() })),
  );
  const currencyInput = currencySelect("currency-select", "main-currency", book.settings.currency);
  currencyInput.addEventListener("change", (event) => {
    changeSetting({ currency: event.target.value }, "currency-select");
    if (needsRates()) {
      refreshRates({ quiet: false });
    }
  });
  const restoreInput = h("input", { type: "file", id: "restore-input", accept: ".json,application/json", onchange: previewRestore });
  return [
    h(
      "section",
      { class: "card" },
      h("label", { for: "lang-select", text: t("language") }),
      langSelect,
      h("label", { for: "currency-select", text: t("mainCurrency") }),
      currencyInput,
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "rates-heading" },
      h("h2", { id: "rates-heading", text: t("ratesTitle") }),
      h("p", { class: "hint", text: rates ? t("ratesFrom", { date: rates.date }) : t("ratesNone") }),
      h("button", { type: "button", class: "button-secondary", id: "rates-button", text: t("updateRates"), onclick: () => refreshRates() }),
    ),
    h(
      "section",
      { class: "card", id: "home-screen-card", "aria-labelledby": "home-heading" },
      h("h2", { id: "home-heading", text: t("homeTitle") }),
      ...(isHomeScreenApp()
        ? [h("p", { class: "hint", text: t("homeInstalled") })]
        : [h("p", { class: "hint", text: t("homeHowTo") }), h("p", { class: "hint", text: t("homeMoveData") })]),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "backup-heading" },
      h("h2", { id: "backup-heading", text: t("backupTitle") }),
      h("p", { class: "hint", text: t("backupHelp") }),
      h("button", { type: "button", class: "button-secondary", id: "download-button", text: t("download"), onclick: downloadBackup }),
      h("h3", { text: t("restoreTitle"), style: "margin-top:16px" }),
      h("label", { for: "restore-input", text: t("restoreChoose") }),
      restoreInput,
      h("div", { id: "restore-area" }),
    ),
  ];
}

function changeSetting(changes, focusId) {
  if (commit({ ...book, settings: { ...book.settings, ...changes } })) {
    document.getElementById(focusId)?.focus();
  }
}

function downloadBackup() {
  const file = `tallyup-backup-${localDateKey(new Date())}.json`;
  const blob = new Blob([JSON.stringify(buildBackup(book), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: file });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  showToast(t("downloaded", { file }));
}

async function previewRestore(event) {
  const input = event.target;
  const area = document.getElementById("restore-area");
  pendingRestore = null;
  area.replaceChildren();
  const file = input.files[0];
  if (!file) {
    return;
  }
  const result = parseBackup(await file.text());
  input.value = "";
  if (!result.ok) {
    area.replaceChildren(h("p", { class: "form-error", role: "alert", text: t(result.error) }));
    return;
  }
  pendingRestore = result.book;
  area.replaceChildren(
    h("p", {
      role: "status",
      text: t("restorePreview", {
        members: result.book.members.length,
        records: result.book.records.length,
        curMembers: book.members.length,
        curRecords: book.records.length,
      }),
    }),
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "button", class: "button-primary", id: "restore-confirm", text: t("restoreConfirm"), onclick: confirmRestore }),
      h("button", {
        type: "button",
        class: "button-secondary",
        text: t("cancel"),
        onclick: () => {
          pendingRestore = null;
          area.replaceChildren();
          document.getElementById("restore-input").focus();
        },
      }),
    ),
  );
}

function confirmRestore() {
  if (!pendingRestore) {
    return;
  }
  const restored = { ...pendingRestore, settings: { ...book.settings, ...pendingRestore.settings } };
  pendingRestore = null;
  if (commit(restored, { message: t("restored"), undoMessage: t("restored") })) {
    document.getElementById("undo-button")?.focus();
  }
}
