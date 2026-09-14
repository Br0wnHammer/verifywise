import { useCallback, useEffect, useState } from "react";
import type { Lang } from "../../i18n/translations";
import { getLanguage, translateKey } from "../../i18n/domTranslator";

/**
 * Lightweight reactive translation hook.
 *
 * Reads the active language from the DOM translator and re-renders when
 * `setLanguage()` dispatches the `vw:languagechange` event.
 */
export const useTranslation = () => {
  const [lang, setLang] = useState<Lang>(getLanguage());

  useEffect(() => {
    const handleChange = (e: Event) => {
      const next = (e as CustomEvent<{ lang: Lang }>).detail?.lang;
      if (next) setLang(next);
    };

    if (typeof window !== "undefined") {
      window.addEventListener("vw:languagechange", handleChange);
      return () => window.removeEventListener("vw:languagechange", handleChange);
    }
    return undefined;
  }, []);

  const t = useCallback(
    (key: string): string => translateKey(key),
    // lang re-binds the callback so consumers re-render on language change;
    // the lookup itself reads the DOM translator's loaded dictionary.
    [lang],
  );

  return { t, lang };
};

export default useTranslation;
