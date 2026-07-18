import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { UI_CATALOG } from "./catalog.generated";
import { ACTION_CATALOG } from "./catalog.actions";

export const APP_LANGUAGE_KEY = "owllm:language";

export type AppLanguage = "en" | "zh-CN" | "ko" | "ja" | "ar" | "it" | "hi" | "pt";
// flagSrc points at the bundled cross-platform flag icons (icons/App_icons →
// served at /App_icons/* by vite.config.ts, same mechanism as /Page_icons).
export type LanguageOption = { code: AppLanguage; flagSrc: string; label: string };

export const APP_LANGUAGES: LanguageOption[] = [
  { code: "en",    flagSrc: "/App_icons/usa_flag.webp",    label: "English" },
  { code: "zh-CN", flagSrc: "/App_icons/china_flag.webp",  label: "Chinese" },
  { code: "ko",    flagSrc: "/App_icons/korea_flag.webp",  label: "Korean" },
  { code: "ja",    flagSrc: "/App_icons/japan_flag.webp",  label: "Japanese" },
  { code: "ar",    flagSrc: "/App_icons/saudi_flag.webp",  label: "Arabic" },
  { code: "it",    flagSrc: "/App_icons/italy_flag.webp",  label: "Italian" },
  { code: "hi",    flagSrc: "/App_icons/india_flag.webp",  label: "Hindi" },
  { code: "pt",    flagSrc: "/App_icons/brazil_flag.webp", label: "Portuguese" },
];

const localeColumn: Record<AppLanguage, number> = {
  en: 0, "zh-CN": 1, ko: 2, ja: 3, ar: 4, it: 5, hi: 6, pt: 7,
};

export function readAppLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(APP_LANGUAGE_KEY);
    if (APP_LANGUAGES.some((language) => language.code === saved)) return saved as AppLanguage;
  } catch { /* localStorage blocked */ }
  return "en";
}

export function bootstrapLocalization() {
  const language = readAppLanguage();
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
}

type TemplateTranslation = { regex: RegExp; translated: string };
const exactByLocale = new Map<AppLanguage, Map<string, string>>();
const templatesByLocale = new Map<AppLanguage, TemplateTranslation[]>();

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dictionaries(language: AppLanguage) {
  let exact = exactByLocale.get(language);
  let templates = templatesByLocale.get(language);
  if (exact && templates) return { exact, templates };
  exact = new Map<string, string>();
  templates = [];
  const column = localeColumn[language];
  const addRow = (row: readonly string[]) => {
    const source = row[0];
    const translated = row[column] || source;
    if (!source.includes("{0}")) {
      exact.set(source, translated);
      return;
    }
    const pieces = source.split(/\{\d+\}/g).map(escapeRegex);
    const regex = new RegExp(`^${pieces.join("([\\s\\S]*?)")}$`);
    templates.push({ regex, translated });
  };
  for (const row of UI_CATALOG as readonly (readonly string[])[]) addRow(row);
  for (const row of ACTION_CATALOG) addRow(row);
  exactByLocale.set(language, exact);
  templatesByLocale.set(language, templates);
  return { exact, templates };
}

export function translateUiText(source: string, language: AppLanguage = readAppLanguage()): string {
  if (!source || language === "en") return source;
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  const value = source.slice(leading.length, source.length - trailing.length);
  if (!value) return source;
  const { exact, templates } = dictionaries(language);
  const direct = exact.get(value);
  if (direct) return `${leading}${direct}${trailing}`;
  for (const template of templates) {
    const match = template.regex.exec(value);
    if (!match) continue;
    const translated = template.translated.replace(/\{(\d+)\}/g, (_, index) => match[Number(index) + 1] ?? "");
    return `${leading}${translated}${trailing}`;
  }
  // English is the canonical, guaranteed fallback for newly-added copy.
  return source;
}

type LocalizationValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (source: string) => string;
};

const LocalizationContext = createContext<LocalizationValue | null>(null);

const LOCALIZED_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"] as const;
const SKIP_SELECTOR = "[data-no-localize],.md-body,pre,code,textarea,[contenteditable='true'],.xterm,script,style";

function shouldSkip(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(SKIP_SELECTOR));
}

function useDocumentLocalization(language: AppLanguage) {
  const originals = useRef(new WeakMap<Text, string>());
  const localizedValues = useRef(new WeakMap<Text, string>());
  const originalAttributes = useRef(new WeakMap<Element, Map<string, string>>());
  const localizedAttributes = useRef(new WeakMap<Element, Map<string, string>>());

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.title = `OWLLM — ${translateUiText("Agentic Team", language)}`;
    try { localStorage.setItem(APP_LANGUAGE_KEY, language); }
    catch { /* localStorage blocked */ }

    const localizeText = (node: Text) => {
      if (shouldSkip(node)) return;
      const last = localizedValues.current.get(node);
      if (!originals.current.has(node) || node.data !== last) originals.current.set(node, node.data);
      const original = originals.current.get(node) ?? node.data;
      const next = translateUiText(original, language);
      localizedValues.current.set(node, next);
      if (node.data !== next) node.data = next;
    };
    const localizeElement = (element: Element) => {
      if (shouldSkip(element)) return;
      let originalsForElement = originalAttributes.current.get(element);
      let localizedForElement = localizedAttributes.current.get(element);
      if (!originalsForElement) {
        originalsForElement = new Map();
        originalAttributes.current.set(element, originalsForElement);
      }
      if (!localizedForElement) {
        localizedForElement = new Map();
        localizedAttributes.current.set(element, localizedForElement);
      }
      for (const attribute of LOCALIZED_ATTRIBUTES) {
        const current = element.getAttribute(attribute);
        if (current == null) continue;
        if (!originalsForElement.has(attribute) || current !== localizedForElement.get(attribute)) {
          originalsForElement.set(attribute, current);
        }
        const next = translateUiText(originalsForElement.get(attribute) ?? current, language);
        localizedForElement.set(attribute, next);
        if (current !== next) element.setAttribute(attribute, next);
      }
    };
    const localizeTree = (root: Node) => {
      if (root.nodeType === Node.TEXT_NODE) localizeText(root as Text);
      if (root.nodeType === Node.ELEMENT_NODE) localizeElement(root as Element);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) localizeText(node as Text);
        else localizeElement(node as Element);
        node = walker.nextNode();
      }
    };

    localizeTree(document.body);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") localizeText(mutation.target as Text);
        else if (mutation.type === "attributes") localizeElement(mutation.target as Element);
        else mutation.addedNodes.forEach(localizeTree);
      }
    });
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: [...LOCALIZED_ATTRIBUTES],
    });
    window.dispatchEvent(new CustomEvent("owllm:language-changed", { detail: language }));
    return () => observer.disconnect();
  }, [language]);
}

export function LocalizationProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(() => readAppLanguage());
  const languageRef = useRef(language);
  languageRef.current = language;
  useDocumentLocalization(language);

  const t = useCallback((source: string) => translateUiText(source, language), [language]);
  const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);

  useEffect(() => {
    const nativeAlert = window.alert.bind(window);
    const nativeConfirm = window.confirm.bind(window);
    const nativePrompt = window.prompt.bind(window);
    window.alert = (message) => nativeAlert(translateUiText(String(message ?? ""), languageRef.current));
    window.confirm = (message) => nativeConfirm(translateUiText(String(message ?? ""), languageRef.current));
    window.prompt = (message, defaultValue) => nativePrompt(translateUiText(String(message ?? ""), languageRef.current), defaultValue);
    return () => {
      window.alert = nativeAlert;
      window.confirm = nativeConfirm;
      window.prompt = nativePrompt;
    };
  }, []);

  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>;
}

export function useLocalization(): LocalizationValue {
  const value = useContext(LocalizationContext);
  if (!value) throw new Error("useLocalization must be used inside LocalizationProvider");
  return value;
}
