// Connects the page to the money rules in ledger.js.

import {
  betResult,
  buildBackup,
  cardTotal,
  commonAmounts,
  convert,
  csvText,
  filterRecords,
  isRealDate,
  loadBook,
  localDateKey,
  memberIsUsed,
  memberStats,
  monthlyWinnings,
  parseAmount,
  parseBackup,
  peopleIn,
  recordBalances,
  recordProblem,
  recordsBetween,
  recordWinnings,
  roundMoney,
  settlementPlan,
  splitSharesLeft,
  STORAGE_KEY,
  sumByMember,
} from "./ledger.js";
import { decimalMark, getLang, LANGS, locale, setLang, t } from "./i18n.js";

const RATES_KEY = "tallyup.rates";
// When this browser last started a backup download (an ISO time). Kept apart
// from the book, so restoring or undoing never changes it.
const BACKUP_TIME_KEY = "tallyup.lastBackupStarted";
// A short fingerprint of the records at the last backup, to tell whether
// anything was recorded since.
const BACKUP_RECORDS_KEY = "tallyup.lastBackupRecords";
const BACKUP_REMINDER_MS = 7 * 86_400_000;
// Light, dark or follow the system, per device (index.html applies it early).
const THEME_KEY = "tallyup.theme";
const THEME_LABELS = { system: "themeSystem", light: "themeLight", dark: "themeDark" };
// Which member is "me" on this device, for the settle page. Per device, since
// each phone belongs to a different person.
const ME_KEY = "tallyup.me";
// Colours for the circle before each name: white initials stay readable
// (5:1 or more) on every one. Given in the order people were added, so the
// first eight all differ and a rename keeps the colour.
// How many changes Undo can go back.
const UNDO_LIMIT = 10;
const AVATAR_COLORS = ["#1565c0", "#c62828", "#2e7d32", "#6a1b9a", "#b45309", "#00695c", "#ad1457", "#6d4c41"];
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
// The search on the Records tab ({ text, type, memberId }), or null for the day view.
let search = null;
// The settle page's date range for wins and losses; not saved.
let resultsRange = { from: "", to: "" };
// The member whose history is open on the People tab, or null for the list.
let viewingMemberId = null;
// The book before each recent delete, settle or restore, newest last, for Undo.
// Adding or editing clears it, since going back would also lose that change.
let undoSteps = [];
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
  // Price or odds fill in the max payout; typing in the payout itself is left alone.
  recordForm.addEventListener("input", (event) => {
    if (["price", "price-kind", "stake"].includes(event.target.name)) {
      applyBetPrice();
    }
  });
  recordForm.addEventListener("change", (event) => {
    if (event.target.name === "price-kind") {
      applyBetPrice();
    }
  });
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
// and keeps the previous version for Undo when undoMessage is given. Any
// other change clears Undo, unless keepUndo says it's safe to go back past it.
function commit(nextBook, { message = null, undoMessage = null, keepUndo = false } = {}) {
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
  if (undoMessage) {
    undoSteps = [...undoSteps, { message: undoMessage, book: previous }].slice(-UNDO_LIMIT);
  } else if (!keepUndo) {
    undoSteps = [];
  }
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

// Settings kept on this device only (not in the book): reading never throws
// and gives null when the value is missing or storage is blocked; writing
// says whether it worked, and null removes the value.
function deviceGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function deviceSet(key, value) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
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
  const content = { records: renderRecords, settle: renderSettle, people: renderPeopleTab, more: renderMore }[tab]();
  view.replaceChildren(...[renderUndo(), ...content].filter(Boolean));
}

function renderUndo() {
  const latest = undoSteps.at(-1);
  if (!latest) {
    return null;
  }
  return h(
    "div",
    { class: "card undo-bar", role: "status" },
    h(
      "div",
      {},
      h("p", { text: latest.message }),
      undoSteps.length > 1 ? h("p", { class: "muted", id: "undo-count", text: t("undoSteps", { count: undoSteps.length }) }) : null,
    ),
    h("button", { type: "button", class: "button-secondary", id: "undo-button", text: t("undo"), onclick: undoLast }),
  );
}

// Goes back one step. The settings stay as they are now.
function undoLast() {
  const latest = undoSteps.at(-1);
  undoSteps = undoSteps.slice(0, -1);
  if (!commit({ ...latest.book, settings: book.settings }, { message: t("undone"), keepUndo: true })) {
    undoSteps = [...undoSteps, latest];
    render();
    return;
  }
  // With more to undo, stay on the button so it can be pressed again.
  (document.getElementById("undo-button") ?? view).focus();
}

// ----- Records tab -----

function renderRecords() {
  if (search) {
    return renderSearch();
  }
  const dayRecords = book.records.filter((record) => record.date === selectedDate);
  return [
    backupReminder(),
    h("button", { type: "button", class: "button-secondary search-open", id: "search-open", text: t("searchOpen"), onclick: openSearch }),
    renderDayPicker(),
    ...renderAddButtons(),
    renderDayResults(dayRecords),
    dayRecords.length
      ? h("ul", { class: "record-list", "aria-label": t("tabRecords") }, dayRecords.map(renderRecord))
      : h("p", { class: "muted", text: t("noRecordsDay") }),
    renderDaysWithRecords(),
  ];
}

// The day's heading, ‹ date ›, and a Today button when another day is shown.
function renderDayPicker() {
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
  return h(
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
  );
}

// Add buttons, or a pointer to People until there are two members.
function renderAddButtons() {
  const parts = [];
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
  return parts;
}

// The day's wins and losses, with Share this day.
function renderDayResults(dayRecords) {
  const { totals, missing } = sumByMember(dayRecords, recordWinnings, book.settings.currency, rates);
  return h(
    "section",
    { class: "card", "aria-labelledby": "day-results-heading" },
    h("h2", { id: "day-results-heading", text: t("dayResults") }),
    amountList(totals, t("dayResultsEmpty")),
    missingNote(missing),
    dayRecords.length
      ? h("button", { type: "button", class: "button-secondary share-day", id: "share-day", text: t("shareDay"), onclick: () => shareText(dayShareText(selectedDate), "day-share-fallback") })
      : null,
    h("div", { id: "day-share-fallback" }),
  );
}

// Every day that has records, newest first, with how many each has.
function renderDaysWithRecords() {
  const counts = new Map();
  for (const record of book.records) {
    counts.set(record.date, (counts.get(record.date) ?? 0) + 1);
  }
  const days = [...counts.keys()].sort().reverse();
  if (!days.length) {
    return null;
  }
  return h(
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
            h("span", { class: "muted", text: t("recordCount", { n: counts.get(day) }) }),
          ),
        ),
      ),
    ),
  );
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

// Records page: when the last backup is over a week old (or there's none) and
// records have changed since, say so and offer a way there.
function backupReminder() {
  if (!book.records.length) {
    return null;
  }
  const started = lastBackupTime();
  const backedUpRecords = deviceGet(BACKUP_RECORDS_KEY);
  if (started && (Date.now() - started.getTime() <= BACKUP_REMINDER_MS || backedUpRecords === recordsFingerprint(book.records))) {
    return null;
  }
  return h(
    "section",
    { class: "card backup-reminder", id: "backup-reminder" },
    h("p", { text: started ? t("backupRemindOld", { ago: daysAgoText(started) }) : t("backupRemindNever") }),
    h("button", { type: "button", class: "button-secondary", id: "backup-reminder-go", text: t("goBackup"), onclick: goToBackup }),
  );
}

function goToBackup() {
  goToTab("more");
  const button = document.getElementById("download-button");
  button.scrollIntoView({ block: "center" });
  button.focus();
}

function goToRestore() {
  goToTab("more");
  const restoreInput = document.getElementById("restore-input");
  restoreInput.scrollIntoView({ block: "center" });
  restoreInput.focus();
}

// A list of names with signed amounts in the main currency, biggest win first.
// A coloured circle with the name's first letter. The letter comes from CSS,
// so screen readers and copied text get the name only once.
function avatar(memberId) {
  const name = nameOf(memberId);
  const position = Math.max(0, book.members.findIndex((member) => member.id === memberId));
  const first = typeof Intl.Segmenter === "function" ? new Intl.Segmenter().segment(name)[Symbol.iterator]().next().value?.segment : [...name][0];
  return h("span", {
    class: "avatar",
    "aria-hidden": "true",
    "data-initial": (first ?? "?").toLocaleUpperCase(),
    style: `background-color: ${AVATAR_COLORS[position % AVATAR_COLORS.length]}`,
  });
}

function amountList(totals, emptyText) {
  const entries = Object.entries(totals).filter(([, amount]) => Math.abs(amount) >= 0.005);
  if (!entries.length) {
    return h("p", { class: "muted", text: emptyText });
  }
  entries.sort((a, b) => b[1] - a[1]);
  return h(
    "ul",
    { class: "amount-list" },
    entries.map(([id, amount]) => h("li", {}, h("span", { class: "name" }, avatar(id), nameOf(id)), h("span", { class: amountClass(amount), text: signedMoney(amount) }))),
  );
}

function missingNote(missing) {
  return missing.length ? h("p", { class: "hint", text: t("missingRates", { list: missing.join(", ") }) }) : null;
}

// ----- Search -----

function openSearch() {
  search = { text: "", type: "", memberId: "" };
  render();
  document.getElementById("search-text")?.focus();
}

function closeSearch() {
  search = null;
  render();
  document.getElementById("search-open")?.focus();
}

// The search form stays as it is while typing; only the results are redrawn,
// so the keyboard doesn't close.
function renderSearch() {
  const update = (field) => (event) => {
    search = { ...search, [field]: event.target.value };
    document.getElementById("search-results").replaceChildren(...searchResults());
  };
  const typeSelect = h(
    "select",
    { id: "search-type", onchange: update("type") },
    [["", t("searchAll")], ["card", t("typeCard")], ["bet", t("typeBet")], ["split", t("typeSplit")], ["payment", t("typePayment")]].map(([value, label]) =>
      h("option", { value, text: label, selected: value === search.type }),
    ),
  );
  const personSelect = h(
    "select",
    { id: "search-person", onchange: update("memberId") },
    h("option", { value: "", text: t("searchAll") }),
    book.members.map((member) => h("option", { value: member.id, text: member.name, selected: member.id === search.memberId })),
  );
  return [
    h(
      "section",
      { class: "card", "aria-labelledby": "search-heading" },
      h("h2", { id: "search-heading", text: t("searchOpen") }),
      h("p", { class: "hint", text: t("searchHint") }),
      h("label", { for: "search-text", text: t("searchText") }),
      h("input", { type: "search", id: "search-text", autocomplete: "off", placeholder: t("searchPlaceholder"), value: search.text, oninput: update("text") }),
      h("div", { class: "search-filters" }, h("div", {}, h("label", { for: "search-type", text: t("searchType") }), typeSelect), h("div", {}, h("label", { for: "search-person", text: t("searchPerson") }), personSelect)),
      h("button", { type: "button", class: "button-secondary search-close", id: "search-close", text: t("searchClose"), onclick: closeSearch }),
    ),
    h("div", { id: "search-results", "aria-live": "polite" }, ...searchResults()),
  ];
}

function searchResults() {
  const found = filterRecords(book.records, book.members, search);
  if (!found.length) {
    return [h("p", { class: "muted", id: "search-count", text: t("searchNone") })];
  }
  return [
    h("p", { class: "muted", id: "search-count", text: t("searchCount", { n: found.length }) }),
    h("ul", { class: "record-list" }, found.map((record) => renderRecord(record, { showDate: true }))),
  ];
}

// "打牌", "赌球", "AA 平摊" or "还款" in the current language.
function typeName(type) {
  return t({ card: "typeCard", bet: "typeBet", split: "typeSplit", payment: "typePayment" }[type]);
}

function renderRecord(record, { showDate = false } = {}) {
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
      record.pointValue ? h("p", { class: "muted", text: t("perPoint", { amount: money(record.pointValue, record.currency) }) }) : null,
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
      showDate ? h("span", { class: "record-date", text: longDate(record.date) }) : null,
      h("span", { class: "badge badge-type", text: typeName(record.type) }),
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
        : h("button", { type: "button", class: "button-secondary", text: t("edit"), "aria-label": `${t("edit")} ${typeName(record.type)}`, onclick: () => editRecord(record) }),
      h("button", { type: "button", class: "button-secondary button-danger", text: t("delete"), "aria-label": `${t("delete")} ${typeName(record.type)}`, onclick: () => deleteRecord(record) }),
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

function editRecord(record) {
  if (record.settled) {
    settledWarning(record, "settledEditHelp", t("keepEditing"), () => openRecordDialog(record.type, record));
  } else {
    openRecordDialog(record.type, record);
  }
}

function deleteRecord(record) {
  const records = book.records.filter((other) => other.id !== record.id);
  const finish = () => {
    if (commit(withRecords(records), { undoMessage: t("deleted") })) {
      document.getElementById("undo-button")?.focus();
    }
  };
  if (record.settled) {
    settledWarning(record, "settledDeleteHelp", t("delete"), finish);
    return;
  }
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
  const hasRefund = after.transfers.some((transfer) => transfer.refund);
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
  showConfirm(t(newRecord ? "impactTitleEdit" : "impactTitleDelete"), parts, t(newRecord ? "impactConfirmEdit" : "impactConfirmDelete"), onConfirm);
  return true;
}

// A question in a dialog with a confirm and a Cancel button. Cancel (or Esc)
// only closes it; onConfirm runs only on confirm.
function showConfirm(title, parts, confirmText, onConfirm) {
  document.getElementById("impact-title").textContent = title;
  document.getElementById("impact-confirm").textContent = confirmText;
  document.getElementById("impact-cancel").textContent = t("cancel");
  // replaceChildren would print an empty part as "null", so those are left out.
  document.getElementById("impact-body").replaceChildren(...parts.filter(Boolean));
  pendingImpact = onConfirm;
  impactDialog.showModal();
}

// Records marked settled are left out of the settle page, so changing one
// changes nothing there. Says so before an edit or delete goes ahead.
function settledWarning(record, helpKey, confirmText, onConfirm) {
  showConfirm(
    t("settledWarnTitle"),
    [
      isRealDate(record.settledOn) ? h("p", { text: t("settledOnDate", { date: longDate(record.settledOn) }) }) : null,
      h("p", { class: "hint", text: t(helpKey) }),
    ],
    confirmText,
    onConfirm,
  );
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

// `next` is the card game just saved with "save, add another": the new form
// keeps its currency and says how many games that day has.
function openRecordDialog(type, existing = null, next = null) {
  recordType = type;
  editingRecord = existing;
  const titleKey = existing ? "editRecord" : { card: "newCard", bet: "newBet", split: "newSplit" }[type];
  document.getElementById("record-dialog-title").textContent = t(titleKey);
  document.getElementById("record-save").textContent = t("save");
  const saveNext = document.getElementById("record-save-next");
  saveNext.textContent = t("saveAndNext");
  saveNext.hidden = type !== "card" || Boolean(existing);
  document.getElementById("record-cancel").textContent = t("cancel");
  recordError.hidden = true;
  const date = existing?.date ?? selectedDate;
  const currency = existing?.currency ?? next?.currency ?? book.settings.currency;
  const fields = [];
  if (next) {
    const games = book.records.filter((record) => record.type === "card" && record.date === next.date).length;
    fields.push(h("p", { class: "saved-note", id: "saved-note", role: "status", text: t("savedGameCount", { n: games }) }));
  }
  fields.push(
    field("date", t("date"), h("input", { type: "date", id: "f-date", name: "date", value: date, required: true })),
    field("currency", t("currency"), currencySelect("f-currency", "currency", currency)),
  );
  fields.push(...{ card: cardFields, bet: betFields, split: splitFields }[type](existing));
  fields.push(h("p", { id: "live-note", class: "live-note", "aria-live": "polite" }));
  if (type === "card") {
    fields.push(h("p", { class: "hint points-preview", id: "points-preview", "aria-live": "polite" }));
    fields.push(h("button", { type: "button", class: "button-secondary fill-last", id: "fill-last", hidden: true, onclick: fillLastPlayer }));
  }
  fields.push(
    field("note", t("noteOptional"), h("input", { id: "f-note", name: "note", autocomplete: "off", maxlength: "200", value: existing?.note ?? "" })),
  );
  recordFields.replaceChildren(...fields);
  updateLivePreview();
  recordDialog.showModal();
  if (next) {
    // Straight to the first amount, with the "saved" line in view above it.
    recordDialog.scrollTop = 0;
    recordFields.querySelector(".player-row:not([hidden]) input[name^='amount-']")?.focus({ preventScroll: true });
  }
}

// The most recently added record of a type, or undefined.
function lastRecordOf(type) {
  return [...book.records].reverse().find((record) => record.type === type);
}

// The card form's fields: point value, one row per member, and "show others".
function cardFields(existing) {
  const fields = [];
  // Start with the people in this game (when editing) or in the last card
  // game; everyone else is one tap away.
  const lastCard = lastRecordOf("card");
  const players = new Set(Object.keys(existing?.amounts ?? lastCard?.amounts ?? {}));
  const others = players.size ? book.members.filter((member) => !players.has(member.id)) : [];
  const quickAmounts = commonAmounts(book.records);
  // By points: on when editing such a game, or when the last game was.
  const pointValue = existing ? existing.pointValue : lastCard?.pointValue;
  fields.push(h("p", { class: "hint", text: t("cardHint") }));
  fields.push(
    h(
      "div",
      { class: "points-row" },
      h("label", { class: "chip" }, h("input", { type: "checkbox", name: "by-points", id: "f-by-points", checked: Boolean(pointValue) }), h("span", { text: t("byPoints") })),
      h(
        "div",
        { id: "point-value-field", hidden: !pointValue },
        field("point-value", t("pointValue"), h("input", { id: "f-point-value", name: "point-value", inputmode: "decimal", autocomplete: "off", value: amountForInput(pointValue) })),
        h("p", { class: "hint", text: t("pointsHint") }),
      ),
    ),
  );
  if (others.length && !existing) {
    fields.push(h("p", { class: "hint", text: t("cardLastPlayers") }));
  }
  for (const member of book.members) {
    fields.push(playerRow(member, { existing, pointValue, hidden: others.includes(member), quickAmounts }));
  }
  if (others.length) {
    const showOthers = h("button", {
      type: "button",
      class: "button-secondary show-others",
      id: "show-others",
      text: t("showOthers", { n: others.length }),
      onclick: () => {
        for (const row of recordFields.querySelectorAll(".player-row[hidden]")) {
          row.hidden = false;
        }
        showOthers.remove();
        recordFields.querySelector(`[name="amount-${CSS.escape(others[0].id)}"]`)?.focus();
      },
    });
    fields.push(showOthers);
  }
  return fields;
}

// One player in the card form: name, Won/Lost, amount (points when kept by
// points), and the common-amount shortcuts.
function playerRow(member, { existing, pointValue, hidden, quickAmounts }) {
  const amount = existing?.amounts?.[member.id];
  const lost = amount < 0;
  return h(
    "div",
    { class: "player-row", "data-member": member.id, hidden },
    h("span", { class: "player-name", id: `p-${member.id}` }, avatar(member.id), member.name),
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
      value: amount === undefined ? "" : amountForInput(Math.abs(pointValue && existing ? roundMoney(amount / pointValue) : amount)),
    }),
    quickAmounts.length
      ? h(
          "div",
          { class: "quick-amounts" },
          quickAmounts.map((size) =>
            h("button", {
              type: "button",
              class: "quick-amount",
              text: amountForInput(size),
              "aria-label": t("quickAmountLabel", { name: member.name, amount: amountForInput(size) }),
              onclick: () => fillQuickAmount(member.id, size),
            }),
          ),
        )
      : null,
  );
}

function betFields(existing) {
  const lastBet = lastRecordOf("bet");
  return [
    field("bettor", t("bettor"), memberSelect("f-bettor", "bettor", existing?.bettorId ?? "")),
    field("holder", t("holder"), memberSelect("f-holder", "holder", existing?.holderId ?? lastBet?.holderId ?? "")),
    field("stake", t("stake"), h("input", { id: "f-stake", name: "stake", inputmode: "decimal", autocomplete: "off", value: amountForInput(existing?.stake) })),
    h(
      "fieldset",
      { class: "choice-group price-helper" },
      h("legend", { text: t("priceHelper") }),
      chip("radio", "price-kind", "cents", t("priceCents"), true),
      chip("radio", "price-kind", "odds", t("priceOdds"), false),
      h("input", { id: "f-price", name: "price", inputmode: "decimal", autocomplete: "off", "aria-label": t("priceValue"), "aria-describedby": "price-note" }),
      h("p", { class: "hint price-note", id: "price-note", "aria-live": "polite" }),
    ),
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
  ];
}

function splitFields(existing) {
  // Ticked to start with: this split's people when editing, else the last
  // split's, else everyone.
  const lastSplit = lastRecordOf("split");
  const included = new Set(existing?.participantIds ?? lastSplit?.participantIds ?? book.members.map((member) => member.id));
  return [
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
  ];
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
  if (editingRecord?.settledOn) {
    // Editing a settled record keeps the day it was settled.
    record.settledOn = editingRecord.settledOn;
  }
  const note = String(data.get("note") ?? "").trim();
  if (note) {
    record.note = note;
  }
  if (recordType === "card") {
    const typed = typedCardAmounts();
    const pointValue = cardPointValue();
    record.amounts = {};
    for (const [id, amount] of Object.entries(typed)) {
      // A bad point value is reported as such, so the typed numbers stay as they are.
      record.amounts[id] = pointValue > 0 ? roundMoney(amount * pointValue) : amount;
    }
    if (pointValue !== null) {
      record.pointValue = pointValue;
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
// Bet form: a Kalshi price in cents (stake ÷ price) or decimal odds
// (stake × odds) fills in the max payout, with a line saying how.
function applyBetPrice() {
  const note = document.getElementById("price-note");
  const priceText = recordForm.elements.price?.value.trim();
  if (!note) {
    return;
  }
  note.classList.remove("is-off");
  if (!priceText) {
    note.textContent = "";
    return;
  }
  const kind = recordForm.querySelector('input[name="price-kind"]:checked')?.value ?? "cents";
  const price = readAmount(priceText);
  const stake = readAmount(recordForm.elements.stake.value.trim());
  const valid = kind === "cents" ? price >= 1 && price <= 99 : price > 1;
  if (!valid) {
    note.classList.add("is-off");
    note.textContent = t(kind === "cents" ? "priceBadCents" : "priceBadOdds");
    return;
  }
  if (!(stake > 0)) {
    note.classList.add("is-off");
    note.textContent = t("priceNeedStake");
    return;
  }
  const payout = Math.round((kind === "cents" ? stake / (price / 100) : stake * price) * 100) / 100;
  recordForm.elements.payout.value = amountForInput(payout);
  const currency = recordForm.elements.currency.value;
  note.textContent = t(kind === "cents" ? "priceNoteCents" : "priceNoteOdds", {
    price: amountForInput(price),
    stake: money(stake, currency),
    payout: money(payout, currency),
  });
  updateLivePreview();
}

// Each card player's typed number with its sign: money, or points when
// "by points" is on.
function typedCardAmounts() {
  const data = new FormData(recordForm);
  const typed = {};
  for (const member of book.members) {
    const text = String(data.get(`amount-${member.id}`) ?? "").trim();
    if (text !== "") {
      const amount = readAmount(text);
      typed[member.id] = data.get(`side-${member.id}`) === "lost" ? -amount : amount;
    }
  }
  return typed;
}

// How much one point is worth, NaN if that box isn't a number yet, or null
// when the game isn't kept by points.
function cardPointValue() {
  if (!recordForm.elements["by-points"]?.checked) {
    return null;
  }
  return readAmount(String(recordForm.elements["point-value"].value).trim());
}

// The one shown player still without an amount, and what makes the game add
// up to 0, or null when that isn't clear (none or several empty, or a typo).
function lastPlayerFill() {
  const rows = [...recordFields.querySelectorAll(".player-row:not([hidden])")];
  const empty = rows.filter((row) => !row.querySelector("input[name^='amount-']").value.trim());
  // Typed numbers, so by points it fills in points.
  const amounts = Object.values(typedCardAmounts());
  if (empty.length !== 1 || !amounts.length || !amounts.every(Number.isFinite)) {
    return null;
  }
  const total = Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
  if (total === 0) {
    return null;
  }
  return { memberId: empty[0].dataset.member, amount: -total, currency: recordForm.elements.currency.value, byPoints: cardPointValue() !== null };
}

function updateFillLast() {
  const button = document.getElementById("fill-last");
  const fill = lastPlayerFill();
  button.hidden = !fill;
  if (fill) {
    const size = Math.abs(fill.amount);
    button.textContent = t(fill.byPoints ? "fillLastPoints" : "fillLast", {
      name: nameOf(fill.memberId),
      result: t(fill.amount > 0 ? "won" : "lost"),
      amount: money(size, fill.currency),
      points: amountForInput(size),
    });
  }
}

// By points: the point value box, no money shortcuts, and what the points
// come to in money.
function updatePointsParts(record) {
  const byPoints = "pointValue" in record;
  document.getElementById("point-value-field").hidden = !byPoints;
  for (const shortcuts of recordFields.querySelectorAll(".quick-amounts")) {
    shortcuts.hidden = byPoints;
  }
  const preview = document.getElementById("points-preview");
  const entries = Object.entries(record.amounts);
  preview.textContent =
    byPoints && record.pointValue > 0 && entries.length && entries.every(([, amount]) => Number.isFinite(amount))
      ? t("pointsPreview", { list: entries.map(([id, amount]) => `${nameOf(id)} ${signedMoney(amount, record.currency)}`).join(t("listSeparator")) })
      : "";
}

// A tap on a common amount: fills it in for that player, as if typed.
function fillQuickAmount(memberId, size) {
  const input = recordForm.querySelector(`input[name="amount-${CSS.escape(memberId)}"]`);
  input.value = amountForInput(size);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

// Fills that player's Won/Lost and amount, then moves on to Save.
function fillLastPlayer() {
  const fill = lastPlayerFill();
  if (!fill) {
    return;
  }
  const id = CSS.escape(fill.memberId);
  recordForm.querySelector(`input[name="side-${id}"][value="${fill.amount > 0 ? "won" : "lost"}"]`).checked = true;
  recordForm.querySelector(`input[name="amount-${id}"]`).value = amountForInput(Math.abs(fill.amount));
  updateLivePreview();
  document.getElementById("record-save").focus();
}

function updateLivePreview() {
  const note = document.getElementById("live-note");
  if (!note) {
    return;
  }
  const record = recordFromForm();
  note.classList.remove("is-off");
  if (recordType === "card") {
    updatePointsParts(record);
    const amounts = Object.values(record.amounts).filter(Number.isFinite);
    const total = cardTotal(Object.fromEntries(amounts.map((amount, index) => [index, amount])));
    updateFillLast();
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
  // Points that add up to 0 can miss by a cent once turned into money; only
  // the form still has the points to tell.
  if (problem === "cardNotZero" && record.pointValue && Math.abs(cardTotal(typedCardAmounts())) < 0.005) {
    problem = "pointsRounding";
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
  finishSave(record, records, event.submitter?.id === "record-save-next");
}

function finishSave(record, records, addAnother = false) {
  if (commit(withRecords(records), { message: t("saved") })) {
    selectedDate = record.date;
    recordDialog.close();
    tab = "records";
    render();
    if (addAnother) {
      openRecordDialog("card", null, record);
      return;
    }
    document.querySelector(`[data-record-id="${CSS.escape(record.id)}"] button`)?.focus();
  } else {
    // Keep the form open so nothing typed is lost, and say why.
    recordError.textContent = stale ? t("staleNotice") : t("saveFailed");
    recordError.hidden = false;
  }
}

// ----- Settle tab -----

// Wins and losses from cards and bets, over all dates or a chosen range.
function renderTotals() {
  const { from, to } = resultsRange;
  const ranged = Boolean(from || to);
  const backwards = Boolean(from && to && from > to);
  const { totals, missing } = sumByMember(recordsBetween(book.records, from, to), recordWinnings, book.settings.currency, rates);
  const dateInput = (id, key) =>
    h("input", {
      type: "date",
      id,
      value: resultsRange[key],
      onchange: (event) => {
        const value = event.target.value;
        if (value === "" || isRealDate(value)) {
          resultsRange = { ...resultsRange, [key]: value };
          render();
          document.getElementById(id)?.focus();
        }
      },
    });
  return h(
    "section",
    { class: "card", "aria-labelledby": "totals-heading" },
    h("h2", { id: "totals-heading", text: t(ranged ? "rangeTitle" : "totalResults") }),
    h("p", { class: "hint", text: t("rangeHint") }),
    h(
      "div",
      { class: "range-row" },
      h("label", {}, h("span", { text: t("rangeFrom") }), dateInput("range-from", "from")),
      h("label", {}, h("span", { text: t("rangeTo") }), dateInput("range-to", "to")),
    ),
    ranged
      ? h("button", {
          type: "button",
          class: "button-secondary",
          id: "range-all",
          text: t("rangeAll"),
          onclick: () => {
            resultsRange = { from: "", to: "" };
            render();
            document.getElementById("range-from")?.focus();
          },
        })
      : null,
    backwards ? h("p", { class: "form-error", role: "alert", text: t("rangeBackwards") }) : amountList(totals, t(ranged ? "rangeEmpty" : "dayResultsEmpty")),
    backwards ? null : missingNote(missing),
  );
}

// The member chosen as "me" on More, or null if none (or they're gone).
function meId() {
  const id = deviceGet(ME_KEY);
  return book.members.some((member) => member.id === id) ? id : null;
}

function changeMe(id) {
  if (!deviceSet(ME_KEY, id || null)) {
    showToast(t("meNotKept"));
  }
}

function renderSettle() {
  const currency = book.settings.currency;
  const unsettled = book.records.filter((record) => !record.settled);
  const { balances, transfers: planned, missing } = settlementPlan(book.records, currency, rates);
  // "Me" first: my own transfers lead, the rest keep their order.
  const me = meId();
  const isMine = (transfer) => Boolean(me) && (transfer.from === me || transfer.to === me);
  const transfers = [...planned.filter(isMine), ...planned.filter((transfer) => !isMine(transfer))];
  const mine = me ? balances[me] ?? 0 : null;
  const parts = [
    me
      ? h(
          "section",
          { class: "card me-summary", id: "me-summary", "aria-labelledby": "me-heading" },
          h("h2", { id: "me-heading", text: t("meTitle", { name: nameOf(me) }) }),
          h("p", {
            class: `me-amount ${amountClass(mine)}`,
            id: "me-amount",
            text: mine >= 0.005 ? t("meOwed", { amount: money(mine) }) : mine <= -0.005 ? t("meOwes", { amount: money(-mine) }) : t("meEven"),
          }),
        )
      : null,
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
                { class: [transfer.refund ? "refund" : "", isMine(transfer) ? "is-mine" : ""].join(" ").trim() || null },
                h("span", { class: "name", text: t(transfer.refund ? "refundLine" : "payLine", names) }),
                h("span", { class: "amount", text: amount }),
                h(
                  "div",
                  { class: "transfer-actions" },
                  h("button", {
                    type: "button",
                    class: "button-secondary paid-button",
                    text: t("paidButton"),
                    "aria-label": t("paidButtonLabel", { ...names, amount }),
                    onclick: () => markPaid(transfer),
                  }),
                  h("button", {
                    type: "button",
                    class: "button-secondary remind-button",
                    text: t("remindButton"),
                    "aria-label": t("remindButtonLabel", { ...names, amount }),
                    onclick: () => shareText(reminderText(transfer), "share-fallback"),
                  }),
                ),
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
            return h("li", {}, h("span", { class: "name" }, avatar(member.id), member.name), h("span", { class: amountClass(amount), text: balanceText(amount) }));
          }),
        ),
      ),
    );
    parts.push(renderTotals(), renderMonthlyChart());
  }
  return parts.filter(Boolean);
}

// Each month's wins and losses as bars from a centre line: right and blue for
// won, left and red for lost. Every bar has its amount beside it, so nothing
// depends on colour alone or on hovering. One scale for all months.
function renderMonthlyChart() {
  const currency = book.settings.currency;
  const months = monthlyWinnings(book.records, currency, rates);
  if (!months.length) {
    return null;
  }
  const largest = Math.max(...months.flatMap(({ totals }) => Object.values(totals).map(Math.abs)));
  return h(
    "section",
    { class: "card", id: "monthly-chart", "aria-labelledby": "monthly-heading" },
    h("h2", { id: "monthly-heading", text: t("monthlyTitle") }),
    h("p", { class: "hint", text: t("monthlyHint", { currency }) }),
    h("p", { class: "chart-legend", "aria-hidden": "true" }, h("span", { text: t("chartWin") }), h("span", { class: "legend-loss", text: t("chartLoss") })),
    months.map(({ month, totals, missing }) => {
      const [year, monthNumber] = month.split("-").map(Number);
      const label = new Date(year, monthNumber - 1, 1).toLocaleDateString(locale(), { year: "numeric", month: "long" });
      const rows = book.members
        .map((member) => [member, totals[member.id] ?? 0])
        .filter(([, amount]) => Math.abs(amount) >= 0.005)
        .sort((a, b) => b[1] - a[1]);
      return h(
        "div",
        { class: "month-block", "data-month": month },
        h("h3", { text: label }),
        h(
          "ul",
          { class: "month-bars" },
          rows.map(([member, amount]) =>
            h(
              "li",
              {},
              h("span", { class: "name", text: member.name }),
              h(
                "span",
                { class: "bar-track", "aria-hidden": "true" },
                h("span", { class: amount > 0 ? "bar bar-win" : "bar bar-loss", style: `width: ${((Math.abs(amount) / largest) * 50).toFixed(2)}%` }),
              ),
              h("span", { class: "amount", text: signedMoney(amount) }),
            ),
          ),
        ),
        missingNote(missing),
      );
    }),
  );
}

// One day for the group chat: each record, the day's wins and losses, and
// who pays whom counting only that day's unsettled records.
function dayShareText(day) {
  const currency = book.settings.currency;
  const records = book.records.filter((record) => record.date === day);
  const { totals, missing } = sumByMember(records, recordWinnings, currency, rates);
  const lines = [t("shareDayHeading", { date: longDate(day) }), ""];
  for (const record of records) {
    lines.push(`· ${recordShareLine(record)}`);
  }
  lines.push("", t("shareDayResults"));
  const results = Object.entries(totals)
    .filter(([, amount]) => Math.abs(amount) >= 0.005)
    .sort((a, b) => b[1] - a[1]);
  lines.push(...(results.length ? results.map(([id, amount]) => `${nameOf(id)} ${signedMoney(amount)}`) : [t("dayResultsEmpty")]));
  const { transfers, missing: missingTransfers } = settlementPlan(records, currency, rates);
  lines.push("", t("shareDayTransfers"), ...(transfers.length ? transfers.map(transferText) : [t("shareNothing")]));
  const unconverted = [...new Set([...missing, ...missingTransfers])];
  if (unconverted.length) {
    lines.push("", t("missingRates", { list: unconverted.join(", ") }));
  }
  return lines.join("\n");
}

// One record as a line of text, in the record's own currency.
function recordShareLine(record) {
  const line = t("shareLine", { type: typeName(record.type), text: recordContent(record) });
  return record.note ? `${line} · ${record.note}` : line;
}

// What a record says, without its type or note, in its own currency.
function recordContent(record) {
  const amountOf = (value) => money(value, record.currency);
  let text;
  if (record.type === "card") {
    text = Object.entries(record.amounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, amount]) => `${nameOf(id)} ${signedMoney(amount, record.currency)}`)
      .join(t("listSeparator"));
    if (record.pointValue) {
      text = `${text} · ${t("perPoint", { amount: amountOf(record.pointValue) })}`;
    }
  } else if (record.type === "bet") {
    const summary = t("betSummary", { bettor: nameOf(record.bettorId), holder: nameOf(record.holderId), stake: amountOf(record.stake), payout: amountOf(record.payout) });
    text = `${summary} · ${resultText(record)} ${signedMoney(betResult(record), record.currency)}`;
  } else if (record.type === "payment") {
    text = t("paymentSummary", { from: nameOf(record.fromId), to: nameOf(record.toId), amount: amountOf(record.amount) });
  } else if (record.shares) {
    const shares = Object.entries(record.shares).map(([id, share]) => `${nameOf(id)} ${amountOf(share)}`);
    text = `${t("splitCustomSummary", { payer: nameOf(record.payerId), amount: amountOf(record.amount) })} (${shares.join(t("listSeparator"))})`;
  } else {
    text = t("splitSummary", { payer: nameOf(record.payerId), amount: amountOf(record.amount), n: record.participantIds.length, share: amountOf(roundMoney(record.amount / record.participantIds.length)) });
  }
  return text;
}

// A message for the person who pays (or refunds) on one settle line: who and
// how much, then their records not settled yet, so they can check it. A
// transfer nets several records together, so it can't be traced to just some.
function reminderText(transfer) {
  const names = { from: nameOf(transfer.from), to: nameOf(transfer.to), amount: money(transfer.amount) };
  const theirs = book.records.filter((record) => !record.settled && peopleIn(record).includes(transfer.from));
  const lines = [t(transfer.refund ? "remindRefund" : "remindPay", names)];
  if (theirs.length) {
    lines.push("", t("remindRecords"), ...theirs.map((record) => `· ${longDate(record.date)} ${recordShareLine(record)}`));
  }
  lines.push("", t("remindFooter", { date: longDate(localDateKey(new Date())) }));
  return lines.join("\n");
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

function shareSettlement(transfers) {
  return shareText(settlementText(transfers), "share-fallback");
}

// Opens the phone's share sheet, or copies the text; if neither is allowed,
// shows it in a box under the button (fallbackId) to copy by hand.
async function shareText(text, fallbackId) {
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
    document.getElementById(fallbackId).replaceChildren(h("p", { class: "hint", text: t("copyThis") }), area);
    area.focus();
    area.select();
  }
}

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

// missing: currencies with no rate yet. Their records aren't in the transfers,
// so settling now would drop what they owe.
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

function renderPeopleTab() {
  const member = book.members.find((other) => other.id === viewingMemberId);
  return member ? renderPerson(member) : renderPeople();
}

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
              h("div", { class: "member-name" }, avatar(member.id), member.name),
              h("div", { class: "muted" }, h("span", { text: `${t("recordsOf", { n: count })} · ${t("totalLabel")} ` }), h("span", { class: amountClass(total), text: signedMoney(total) })),
            ),
            h(
              "div",
              { class: "button-row" },
              h("button", { type: "button", class: "button-secondary", text: t("personHistory"), "aria-label": `${t("personHistory")} ${member.name}`, onclick: () => openPerson(member) }),
              h("button", { type: "button", class: "button-secondary", text: t("rename"), "aria-label": `${t("rename")} ${member.name}`, onclick: () => openRename(member) }),
              h("button", { type: "button", class: "button-secondary button-danger", text: t("delete"), "aria-label": `${t("delete")} ${member.name}`, onclick: () => deleteMember(member) }),
            ),
          );
        }),
      )
    : h("p", { class: "muted", text: t("noMembers") });
  return [h("section", { class: "card", "aria-labelledby": "people-heading" }, h("h2", { id: "people-heading", text: t("peopleTitle") }), form), list];
}

function openPerson(member) {
  viewingMemberId = member.id;
  render();
  view.focus();
  window.scrollTo(0, 0);
}

function closePerson() {
  const id = viewingMemberId;
  viewingMemberId = null;
  render();
  document.querySelector(`[data-member-id="${CSS.escape(id)}"] button`)?.focus();
}

// One member's history: their totals now, then every record they're in,
// newest first, each with what it meant for them.
function renderPerson(member) {
  const currency = book.settings.currency;
  const records = book.records
    .filter((record) => memberIsUsed(member.id, [record]))
    .sort((a, b) => b.date.localeCompare(a.date));
  const { totals, missing } = sumByMember(book.records, recordWinnings, currency, rates);
  const { balances } = settlementPlan(book.records, currency, rates);
  const total = totals[member.id] ?? 0;
  const balance = balances[member.id] ?? 0;
  const summary = h(
    "section",
    { class: "card", "aria-labelledby": "person-heading" },
    h("h2", { id: "person-heading", text: member.name }),
    h(
      "ul",
      { class: "amount-list", id: "person-summary" },
      h("li", {}, h("span", { class: "name", text: t("recordsOf", { n: records.length }) })),
      h("li", {}, h("span", { class: "name", text: t("totalLabel") }), h("span", { class: amountClass(total), text: signedMoney(total) })),
      h("li", {}, h("span", { class: "name", text: t("personNow") }), h("span", { class: amountClass(balance), text: balanceText(balance) })),
    ),
    missingNote(missing),
  );
  const list = records.length
    ? h(
        "ul",
        { class: "day-list person-records", id: "person-records" },
        records.map((record) => {
          const line = personLine(record, member.id);
          return h(
            "li",
            {},
            h(
              "button",
              { type: "button", onclick: () => goToRecord(record) },
              h("span", { class: "person-date", text: longDate(record.date) }),
              h("span", { class: "person-what", text: line.text }),
              line.amount === null ? null : h("span", { class: line.isResult ? amountClass(line.amount) : "amount muted", text: signedMoney(line.amount, record.currency) }),
            ),
          );
        }),
      )
    : h("p", { class: "muted", text: t("personNone", { name: member.name }) });
  return [
    h("button", { type: "button", class: "button-secondary back-button", id: "back-to-people", text: t("backToPeople"), onclick: closePerson }),
    summary,
    renderPersonStats(member),
    h(
      "section",
      { class: "card", "aria-labelledby": "person-records-heading" },
      h("h2", { id: "person-records-heading", text: t("personRecordsTitle") }),
      records.length ? h("p", { class: "hint", text: t("personTapHint") }) : null,
      list,
    ),
  ];
}

// Games played and won, win rate, and the biggest win and loss, each a tap
// away from its day.
function renderPersonStats(member) {
  const stats = memberStats(book.records, member.id, book.settings.currency, rates);
  const percent = (part, whole) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(part / whole);
  const extreme = (key, found) =>
    found
      ? h(
          "li",
          {},
          h(
            "button",
            { type: "button", class: "stats-game", id: `stats-${key}`, onclick: () => goToRecord(found.record) },
            h("span", { class: "person-date", text: t(key === "best" ? "statsBest" : "statsWorst", { date: longDate(found.record.date) }) }),
            h("span", { class: amountClass(found.amount), text: signedMoney(found.amount, found.record.currency) }),
          ),
        )
      : null;
  const parts = [];
  if (stats.games) {
    parts.push(h("p", { id: "stats-cards", text: t("statsCards", { games: stats.games, wins: stats.wins, rate: percent(stats.wins, stats.games) }) }));
    if (stats.best || stats.worst) {
      parts.push(h("ul", { class: "day-list stats-list" }, extreme("best", stats.best), extreme("worst", stats.worst)));
    }
  }
  if (stats.bets) {
    parts.push(h("p", { id: "stats-bets", text: t("statsBets", { bets: stats.bets, wins: stats.betWins, rate: percent(stats.betWins, stats.bets) }) }));
  }
  return h(
    "section",
    { class: "card", "aria-labelledby": "stats-heading" },
    h("h2", { id: "stats-heading", text: t("statsTitle") }),
    ...(parts.length ? parts : [h("p", { class: "muted", text: t("statsNone") })]),
  );
}

// What one record meant for one member: a description, and an amount in the
// record's currency. isResult is true for a win or loss (cards, their own
// bets); AA shares, an account they hold and payments are money moving, not
// winning, so they're shown in grey, as in the totals.
function personLine(record, id) {
  if (record.type === "card") {
    return { text: t("typeCard"), amount: record.amounts[id], isResult: true };
  }
  if (record.type === "bet") {
    if (record.bettorId === id) {
      const text = record.holderId === id ? t("personBetOwn") : t("personBet", { holder: nameOf(record.holderId) });
      return { text, amount: betResult(record), isResult: true };
    }
    return { text: t("personHolder", { bettor: nameOf(record.bettorId) }), amount: roundMoney(-betResult(record)), isResult: false };
  }
  if (record.type === "payment") {
    return record.fromId === id
      ? { text: t("personPaid", { to: nameOf(record.toId), amount: money(record.amount, record.currency) }), amount: null }
      : { text: t("personReceived", { from: nameOf(record.fromId), amount: money(record.amount, record.currency) }), amount: null };
  }
  const paid = record.payerId === id ? record.amount : 0;
  const share = roundMoney(paid - (recordBalances(record)[id] ?? 0));
  const amount = money(record.amount, record.currency);
  if (!record.participantIds.includes(id)) {
    return { text: t("personSplitPaid", { amount }), amount: null };
  }
  return paid
    ? { text: t("personSplitPaidShare", { amount, share: money(share, record.currency) }), amount: null }
    : { text: t("personSplitShare", { share: money(share, record.currency), payer: nameOf(record.payerId) }), amount: null };
}

// From someone's history to the day of one of their records.
function goToRecord(record) {
  tab = "records";
  setDay(record.date);
  const item = document.querySelector(`[data-record-id="${CSS.escape(record.id)}"]`);
  item?.scrollIntoView({ block: "center" });
  item?.querySelector("button")?.focus();
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

// A short form a friend fills in and sends back, naming the language and the
// published version (deploy.sh writes the commit into index.html).
function translationFeedbackText() {
  const version = document.querySelector('meta[name="tallyup-version"]')?.content || "?";
  return [
    t("feedbackHeading"),
    t("feedbackLanguage", { name: LANGS[getLang()], code: getLang() }),
    t("feedbackVersion", { version }),
    t("feedbackPage"),
    t("feedbackNow"),
    t("feedbackBetter"),
  ].join("\n");
}

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
      h("label", { for: "theme-select", text: t("appearance") }),
      h(
        "select",
        { id: "theme-select", onchange: (event) => changeTheme(event.target.value) },
        Object.entries(THEME_LABELS).map(([theme, label]) => h("option", { value: theme, text: t(label), selected: theme === currentTheme() })),
      ),
      h("label", { for: "me-select", text: t("meLabel") }),
      h(
        "select",
        { id: "me-select", onchange: (event) => changeMe(event.target.value) },
        h("option", { value: "", text: t("meNone") }),
        book.members.map((member) => h("option", { value: member.id, text: member.name, selected: member.id === meId() })),
      ),
      h("label", { for: "currency-select", text: t("mainCurrency") }),
      currencyInput,
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "feedback-heading" },
      h("h2", { id: "feedback-heading", text: t("feedbackTitle") }),
      h("p", { class: "hint", text: t("feedbackHint") }),
      h("button", { type: "button", class: "button-secondary", id: "feedback-button", text: t("feedbackButton"), onclick: () => shareText(translationFeedbackText(), "feedback-fallback") }),
      h("div", { id: "feedback-fallback" }),
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
      h("p", { class: "backup-status", id: "backup-status", "aria-live": "polite", text: backupStatusText() }),
      h("p", { class: "backup-warning", id: "backup-warning", role: "alert", hidden: true, text: t("backupTimeNotSaved") }),
      h("button", { type: "button", class: "button-secondary", id: "download-button", text: t("download"), onclick: downloadBackup }),
      h("h3", { text: t("restoreTitle"), style: "margin-top:16px" }),
      h("label", { for: "restore-input", text: t("restoreChoose") }),
      restoreInput,
      h("div", { id: "restore-area" }),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "csv-heading" },
      h("h2", { id: "csv-heading", text: t("csvTitle") }),
      h("p", { class: "hint", text: t(book.records.length ? "csvHelp" : "csvEmpty") }),
      h("button", { type: "button", class: "button-secondary", id: "csv-button", text: t("csvDownload"), disabled: !book.records.length, onclick: exportCsv }),
    ),
  ];
}

function currentTheme() {
  return document.documentElement.dataset.theme ?? "system";
}

// Takes effect at once; it's kept for next time if storage allows.
function changeTheme(theme) {
  const chosen = theme === "light" || theme === "dark" ? theme : null;
  if (chosen) {
    document.documentElement.dataset.theme = chosen;
  } else {
    delete document.documentElement.dataset.theme;
  }
  if (!deviceSet(THEME_KEY, chosen)) {
    showToast(t("themeNotKept"));
  }
}

function changeSetting(changes, focusId) {
  // Undo keeps the current settings, so changing one doesn't clear it.
  if (commit({ ...book, settings: { ...book.settings, ...changes } }, { keepUndo: true })) {
    document.getElementById(focusId)?.focus();
  }
}

// The time is recorded only once the file was made and its download started.
// Browsers don't tell a page whether the file was then saved, so the status
// says "download started", never "saved".
// Hands the browser a file to download. Throws if the file can't be made.
function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadBackup() {
  const file = `tallyup-backup-${localDateKey(new Date())}.json`;
  try {
    saveFile(file, JSON.stringify(buildBackup(book), null, 2), "application/json");
  } catch {
    showToast(t("backupFailed"));
    return;
  }
  // The download has started either way; only the time may not be kept.
  const timeKept = deviceSet(BACKUP_RECORDS_KEY, recordsFingerprint(book.records)) && deviceSet(BACKUP_TIME_KEY, new Date().toISOString());
  const status = document.getElementById("backup-status");
  if (status) {
    status.textContent = backupStatusText();
  }
  // Without this, the older time above would look like this download's.
  const warning = document.getElementById("backup-warning");
  if (warning) {
    warning.hidden = timeKept;
  }
  showToast(t("downloaded", { file }));
}

// Every record as a spreadsheet row, oldest first. Each person's column holds
// card and bet wins and losses in the main currency, so a column adds up to
// their total on the settle page; shared costs and payments are described in
// words only. The byte-order mark lets Excel read Chinese correctly.
function recordsCsv() {
  const currency = book.settings.currency;
  const header = [
    t("date"),
    t("csvType"),
    t("csvWhat"),
    t("note"),
    t("currency"),
    t("settledBadge"),
    ...book.members.map((member) => t("csvMemberColumn", { name: member.name, currency })),
  ];
  const ordered = book.records.map((record, index) => [record, index]).sort(([a, i], [b, j]) => a.date.localeCompare(b.date) || i - j);
  const rows = ordered.map(([record]) => {
    const winnings = recordWinnings(record);
    const cells = book.members.map((member) => {
      const converted = member.id in winnings ? convert(winnings[member.id], record.currency, currency, rates) : null;
      return converted === null ? "" : roundMoney(converted);
    });
    return [record.date, typeName(record.type), recordContent(record), record.note ?? "", record.currency, record.settled ? t("csvYes") : "", ...cells];
  });
  return `\uFEFF${csvText([header, ...rows])}\r\n`;
}

function exportCsv() {
  const file = `tallyup-records-${localDateKey(new Date())}.csv`;
  try {
    saveFile(file, recordsCsv(), "text/csv;charset=utf-8");
  } catch {
    showToast(t("csvFailed"));
    return;
  }
  showToast(t("downloaded", { file }));
}

// "Last backup download started: <time> (<how long ago>)", or unknown.
function backupStatusText() {
  const started = lastBackupTime();
  if (!started) {
    return t("backupStatusUnknown");
  }
  const time = started.toLocaleString(locale(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return t("backupStatusStarted", { time, ago: daysAgoText(started) });
}

// When a backup download last started in this browser, or null if unknown.
function lastBackupTime() {
  const started = new Date(deviceGet(BACKUP_TIME_KEY) ?? "");
  return Number.isNaN(started.getTime()) ? null : started;
}

// "today", "yesterday", "3 days ago", counted by calendar day.
function daysAgoText(date) {
  const midnight = (day) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(new Date())) / 86_400_000);
  return new Intl.RelativeTimeFormat(locale(), { numeric: "auto" }).format(days, "day");
}

// FNV-1a over the records' JSON: equal records give the same short text.
function recordsFingerprint(records) {
  const text = JSON.stringify(records);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return `${records.length}-${(hash >>> 0).toString(16)}`;
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
