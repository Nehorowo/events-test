import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import el from './locales/el';
import en from './locales/en';

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'el', label: 'Ελληνικά' },
] as const;

function initialLang(): string {
  try {
    const saved = localStorage.getItem('lang');
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('el') ? 'el' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, el: { translation: el } },
  lng: initialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.language;

export function setLang(lng: string, persist = true) {
  if (persist) {
    try {
      localStorage.setItem('lang', lng);
    } catch {
      /* ignore */
    }
  }
  void i18n.changeLanguage(lng);
}

export default i18n;
