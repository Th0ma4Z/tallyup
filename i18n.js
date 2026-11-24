// Every word on screen, in each language. Each language's words are in its
// own file in lang/. t("key", { name: "A" }) fills in {name}. A test checks
// every language has the same keys.

import zh from "./lang/zh.js";
import zhHant from "./lang/zh-Hant.js";
import en from "./lang/en.js";
import es from "./lang/es.js";
import ja from "./lang/ja.js";
import ko from "./lang/ko.js";
import fr from "./lang/fr.js";
import de from "./lang/de.js";

export const LANGS = {
  zh: "简体中文",
  "zh-Hant": "繁體中文",
  en: "English",
  es: "Español",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
};

// The locale each language uses for numbers, dates and currency names.
const LOCALES = { zh: "zh-CN", "zh-Hant": "zh-TW", en: "en-US", es: "es-ES", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE" };

export const STRINGS = { zh, "zh-Hant": zhHant, en, es, ja, ko, fr, de };

let current = "zh";

export function setLang(lang) {
  current = lang in STRINGS ? lang : "zh";
  document.documentElement.lang = LOCALES[current];
}

export function getLang() {
  return current;
}

export function t(key, params = {}) {
  const text = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// The locale used for numbers, dates and currency names.
export function locale() {
  return LOCALES[current];
}

// The mark this language writes before cents: "." or "," (Spanish).
export function decimalMark() {
  return new Intl.NumberFormat(locale()).formatToParts(1.5).find((part) => part.type === "decimal").value;
}
