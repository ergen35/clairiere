import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_LANG, Lang } from '../shared/i18n';
import { api } from './api';
import { App } from './App';
import { applyLang, LangContext } from './i18n';
import { LanguagePicker } from './LanguagePicker';
import './styles.css';

function Root() {
  const [lang, setLang] = useState<Lang | null>(null);
  // 'first': no language saved yet, one must be chosen before anything else.
  const [asking, setAsking] = useState<'first' | 'change' | null>(null);

  useEffect(() => {
    void api.getLanguage().then((saved) => {
      const chosen = saved ?? DEFAULT_LANG;
      applyLang(chosen);
      setLang(chosen);
      if (!saved) setAsking('first');
    });
  }, []);

  const choose = useCallback((next: Lang) => {
    applyLang(next);
    setLang(next);
    setAsking(null);
    void api.setLanguage(next);
  }, []);

  if (!lang) return null;
  return (
    <LangContext.Provider value={lang}>
      <App onChangeLanguage={() => setAsking('change')} />
      {asking && <LanguagePicker initial={lang} first={asking === 'first'} onChoose={choose} onClose={() => setAsking(null)} />}
    </LangContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
