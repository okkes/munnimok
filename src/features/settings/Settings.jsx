import React from 'react';
import { T } from '../../shared/testIds.js';
import { STOCK_AVATARS, CURRENCIES } from '../../shared/constants.js';
import { CATEGORIES } from '../../shared/data/categories.js';
import { computePeriodHistory, fmtEur, fmtDate } from '../../shared/utils/format.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang, OTHER_LANGUAGES, LangCtx, useCurrency } from '../../shared/i18n.jsx';
import { NavCtx, useNav, useDark, Sheet } from '../../app/nav.jsx';
import { useLocalStorage } from '../../shared/hooks.jsx';
import { BarChart } from '../../shared/components/Charts.jsx';
import { useAppCtx, useTxCtx, useProfiles, useCatCtx, Stat } from '../../app/providers.jsx';
import { Toggle, FormRow } from '../events/Events.jsx';
import { HOME_CARDS_DEFAULT } from '../accounts/Accounts.jsx';
import { ProfileAvatar } from '../profile/Profile.jsx';
import { CategoryPicker } from '../review/Review.jsx';
import { DUTCH_BANKS } from '../accounts/data.js';
import { getUserId, getUserSyncKey } from '../../shared/utils/user.js';

function LangHighlight({ text, query }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return <>{text.slice(0, idx)}<mark style={{ background: '#d4edda', color: '#2d6a35', borderRadius: 2, padding: '0 1px', fontWeight: 700 }}>{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}</>;
}

export function ScreenLanguagePicker({ fromOnboarding = false, onBack }) {
  const navCtx = React.useContext(NavCtx);
  const { lang, setLang, t } = useLang();
  const { dark } = useDark();
  const [search, setSearch] = React.useState('');
  // Counter-invert flag images: the app's dark mode is a CSS invert filter on the
  // root div, which incorrectly inverts real photographs and flag images.
  const flagStyle = dark ? { borderRadius:3, flexShrink:0, filter:'invert(1) hue-rotate(180deg)' } : { borderRadius:3, flexShrink:0 };

  const mainLangs = [
    { code:'en', name:'English', native:'English', twemoji:'1f1ec-1f1e7' },
    { code:'nl', name:'Dutch', native:'Nederlands', twemoji:'1f1f3-1f1f1' },
    { code:'tr', name:'Turkish', native:'Türkçe', twemoji:'1f1f9-1f1f7' },
  ];

  const filteredOther = OTHER_LANGUAGES.filter(l =>
    !search || l.name.toLowerCase().includes(search.toLowerCase()) || l.native.toLowerCase().includes(search.toLowerCase())
  );

  const goBack = () => {
    if (onBack) { onBack(); return; }
    if (navCtx) { navCtx.pop(); }
  };

  const selectLang = (code) => {
    if (code === 'en' || code === 'nl' || code === 'tr') {
      setLang(code);
      goBack();
    }
  };

  return (
    <div className="m-screen" style={{ position: 'relative' }}>
      <StatusBar/>
      <AppBar title={t('lang.title')}
        leading={<button className="m-iconbtn m-tap" onClick={goBack}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ fontSize:13, color:M.ink3, marginBottom:20, paddingLeft:4, lineHeight:1.5 }}>
          {t('lang.subtitle')}
        </div>

        {/* Available languages */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('lang.availableNow')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:20, border:`1px solid ${M.line}` }}>
          {mainLangs.map((l, i) => (
            <React.Fragment key={l.code}>
              {i > 0 && <Divider inset={52}/>}
              <div data-testid={`lang-option-${l.code}`} className="m-tap" onClick={() => selectLang(l.code)}
                style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0' }}>
                <img src={`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${l.twemoji}.svg`} width={36} height={36} style={flagStyle} alt={l.name}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:15, fontWeight:600 }}>{l.native}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{l.name}</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>
                    {t('lang.available')}
                  </span>
                  {lang === l.code && (
                    <div style={{ width:20, height:20, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <I name="check" size={11} color="#fff" stroke={2.5}/>
                    </div>
                  )}
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Other languages */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('lang.otherLanguages')}</div>
        <div style={{ position:'relative', marginBottom:10 }}>
          <I name="search" size={14} color={M.ink4} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('lang.searchPlaceholder')}
            style={{ width:'100%', padding:'10px 12px 10px 34px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:13, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
        </div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {filteredOther.map((l, i) => (
            <React.Fragment key={l.code}>
              {i > 0 && <Divider inset={52}/>}
              <div style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 0', opacity:0.6 }}>
                <img src={`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${l.twemoji}.svg`} width={36} height={36} style={flagStyle} alt=""/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}><LangHighlight text={l.native} query={search}/></div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}><LangHighlight text={l.name} query={search}/></div>
                </div>
                <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.line2, color:M.ink3, textTransform:'uppercase' }}>
                  {t('lang.comingSoon')}
                </span>
              </div>
            </React.Fragment>
          ))}
          {filteredOther.length === 0 && search && (
            <div style={{ padding:'20px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>No languages found</div>
          )}
        </div>
        <div style={{ height:8 }}/>
      </div>
    </div>
  );
}

export function CurrencyPickerSheet({ open, onClose, value, onChange }) {
  const { t } = useLang();
  const ctx = useCurrency();
  const currency = value !== undefined ? value : ctx.currency;
  const setCurrency = onChange || ctx.setCurrency;
  const [search, setSearch] = React.useState('');
  const filtered = React.useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return CURRENCIES;
    return CURRENCIES.filter(c => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
  }, [search]);
  return (
    <Sheet open={open} onClose={onClose} title={t('appearance.currencyPicker')}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'0 16px 12px', flexShrink:0 }}>
        <I name="search" size={15} color={M.ink4} style={{ flexShrink:0 }}/>
        <input
          data-testid="currency-search"
          autoFocus value={search} onChange={e => setSearch(e.target.value)}
          placeholder={t('appearance.currencySearch')}
          style={{ flex:1, border:'none', outline:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, color:M.ink, padding:0 }}
        />
      </div>
      <div style={{ overflowY:'auto', flex:1 }}>
        <div className="m-card" style={{ padding:'4px 16px', margin:'0 0 24px', border:`1px solid ${M.line}` }}>
          {filtered.length === 0 && (
            <div style={{ padding:'20px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>No results</div>
          )}
          {filtered.map((cur, i) => (
            <React.Fragment key={cur.code}>
              {i > 0 && <Divider inset={0}/>}
              <div data-testid={`currency-option-${cur.code}`} className="m-tap"
                onClick={() => { setCurrency(cur.code); onClose(); }}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                <div style={{ width:36, height:36, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <span style={{ fontSize:15, fontWeight:700, color:M.sage }}>{cur.symbol}</span>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}>{cur.name}</div>
                  <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:1 }}>{cur.code}</div>
                </div>
                {currency === cur.code && (
                  <div style={{ width:20, height:20, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name="check" size={11} color="#fff" stroke={2.5}/>
                  </div>
                )}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

export function ScreenSettings() {
  const nav = useNav();
  const { dark, setDark } = useDark();
  const { t, lang } = useLang();
  const { currency } = useCurrency();
  const [scrollY, setScrollY] = React.useState(0);
  const [settingsSearch, setSettingsSearch] = React.useState('');

  const titleShrunken = scrollY > 44;
  const curInfo = CURRENCIES.find(c => c.code === currency) || { code:'EUR', symbol:'€', name:'Euro' };
  const langName = lang === 'nl' ? 'Nederlands' : lang === 'tr' ? 'Türkçe' : 'English';

  const q = settingsSearch.toLowerCase().trim();
  const visible = (label) => !q || label.toLowerCase().includes(q);

  return (
    <div className="m-screen" style={{ position:'relative' }}>
      <StatusBar/>
      <AppBar
        title={titleShrunken ? t('screen.settings') : ''}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />

      <div className="m-body-scroll" onScroll={e => setScrollY(e.target.scrollTop)} style={{ paddingBottom:96 }}>
        {/* iOS-style large title */}
        <div style={{
          fontSize:30, fontWeight:800, color:M.brand, padding:'2px 20px 18px',
          opacity: titleShrunken ? 0 : 1,
          transform: titleShrunken ? 'translateY(-8px) scale(0.9)' : 'none',
          transformOrigin:'left center',
          transition:'opacity 0.18s, transform 0.18s',
          pointerEvents: titleShrunken ? 'none' : 'auto',
        }}>
          {t('screen.settings')}
        </div>

        {/* Appearance */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('settings.appearance')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {visible(t('settings.darkMode')) && (
            <>
              <div data-testid={T.darkModeToggle} className="m-tap" onClick={() => setDark(!dark)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <I name={dark ? 'moon' : 'sun'} size={18} color={M.ink2}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}>{t('settings.darkMode')}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{dark ? t('settings.darkModeOn') : t('settings.darkModeOff')}</div>
                </div>
                <Toggle on={dark}/>
              </div>
              <Divider inset={0}/>
            </>
          )}
          {visible(t('settings.changeLanguage')) && (
            <div data-testid="settings-language-row" className="m-tap"
              onClick={() => nav.push('language')}
              style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
              <I name="globe" size={18} color={M.ink2}/>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:500 }}>{t('settings.changeLanguage')}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{t('settings.languageSub')}</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ fontSize:13, color:M.ink2, fontWeight:600 }}>{langName}</span>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>
          )}
        </div>

        {/* Behaviour */}
        {(!q || 'behaviour auto-categorize daily summary round-up'.includes(q)) && (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Behaviour</div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
              <SettingToggle label="Auto-categorize" sub="Use AI to classify new tx" on/>
              <Divider inset={0}/>
              <SettingToggle label="Daily summary" sub="9:00 push notification" on/>
              <Divider inset={0}/>
              <SettingToggle label="Round-up to savings" sub={`Round purchases up to nearest ${curInfo.symbol}1`}/>
            </div>
          </>
        )}
      </div>

      {/* Floating search bar */}
      <div style={{
        position:'absolute', bottom:24, left:16, right:16,
        background:M.card, borderRadius:14,
        boxShadow:'0 4px 20px rgba(0,0,0,0.14)',
        border:`1px solid ${M.line}`,
        display:'flex', alignItems:'center', gap:10,
        padding:'11px 14px', zIndex:10,
      }}>
        <I name="search" size={16} color={M.ink4}/>
        <input
          data-testid="settings-search"
          value={settingsSearch}
          onChange={e => setSettingsSearch(e.target.value)}
          placeholder="Search settings…"
          style={{ flex:1, border:'none', outline:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, color:M.ink, padding:0 }}
        />
        {settingsSearch && (
          <button onClick={() => setSettingsSearch('')} style={{ background:'none', border:'none', cursor:'pointer', padding:2, display:'flex' }}>
            <I name="x" size={14} color={M.ink4}/>
          </button>
        )}
      </div>

    </div>
  );
}

export function ScreenPeriods() {
  const nav = useNav();
  const { t } = useLang();
  const [selectedDay, setSelectedDay] = useLocalStorage('munni_period_day', 20);
  const [periodType, setPeriodType] = useLocalStorage('munni_period_type', 'monthly');
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  const ordinalStr = (d) => {
    if (d === 1 || d === 21) return `${d}st`;
    if (d === 2 || d === 22) return `${d}nd`;
    if (d === 3 || d === 23) return `${d}rd`;
    return `${d}th`;
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.periods')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ padding:'12px 16px', borderRadius:12, background:M.sageSoft, marginBottom:18, fontSize:13, color:M.sage, lineHeight:1.6 }}>
          <strong>What is a period?</strong> munni organises your finances in periods. A period starts on your chosen day — ideally when your salary arrives — so income and expenses always line up.
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Period type</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:20 }}>
          {[['monthly','Monthly'],['biweekly','Bi-weekly'],['weekly','Weekly']].map(([type,label]) => (
            <button key={type} className="m-tap" onClick={() => setPeriodType(type)} style={{
              height:48, borderRadius:12, border:`1.5px solid ${periodType===type?M.sage:M.line}`,
              background:periodType===type?M.sage:M.card, color:periodType===type?'#fff':M.ink,
              fontSize:13, fontWeight:periodType===type?700:400, cursor:'pointer', fontFamily:M.fontUI,
            }}>{label}</button>
          ))}
        </div>

        {periodType === 'monthly' ? (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Start day of month</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8, marginBottom:20 }}>
              {days.map(d => (
                <button key={d} className="m-tap" onClick={() => setSelectedDay(d)} style={{
                  height:44, borderRadius:12, border:`1.5px solid ${selectedDay === d ? M.sage : M.line}`,
                  background: selectedDay === d ? M.sage : M.card,
                  color: selectedDay === d ? '#fff' : M.ink,
                  fontSize:14, fontWeight: selectedDay === d ? 700 : 400,
                  cursor:'pointer', fontFamily:M.fontUI,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{d}</button>
              ))}
            </div>
            <div className="m-card" style={{ padding:14, marginBottom:16, border:`1px solid ${M.line}` }}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
              <div style={{ fontSize:13, color:M.ink3 }}>
                Starts on the <strong>{ordinalStr(selectedDay)}</strong> of each month.
              </div>
              <div style={{ fontSize:12, color:M.sage, marginTop:6, fontWeight:500 }}>
                {(() => { const ph = computePeriodHistory(selectedDay); const cur = ph[ph.length-1]; return cur ? cur.label : ''; })()}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Start day of week</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:6, marginBottom:20 }}>
              {DAY_NAMES.map((day, idx) => (
                <button key={idx} className="m-tap" onClick={() => setSelectedDay(idx)} style={{
                  height:44, borderRadius:12, border:`1.5px solid ${selectedDay===idx?M.sage:M.line}`,
                  background:selectedDay===idx?M.sage:M.card, color:selectedDay===idx?'#fff':M.ink,
                  fontSize:11, fontWeight:selectedDay===idx?700:400, cursor:'pointer', fontFamily:M.fontUI,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{day.slice(0,3)}</button>
              ))}
            </div>
            <div className="m-card" style={{ padding:14, marginBottom:16, border:`1px solid ${M.line}` }}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
              <div style={{ fontSize:13, color:M.ink3 }}>
                {periodType === 'weekly' ? 'Weekly' : 'Every 2 weeks'}, starting on <strong>{DAY_NAMES[selectedDay] || 'Monday'}</strong>.
              </div>
            </div>
          </>
        )}

        <div style={{ padding:'10px 14px', borderRadius:10, background:M.ochreSoft, marginBottom:20, fontSize:12, color:M.ochre, lineHeight:1.5 }}>
          <strong>Tip:</strong> Monthly periods work best when your salary arrives on a fixed day.
        </div>

        <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={() => nav.pop()}>
          {t('action.save')}
        </button>
      </div>
    </div>
  );
}

function MunniSVG({ expr }) {
  expr = expr || 'happy';
  const p = { stroke:'#4A2E1E', strokeWidth:1.5, fill:'none', strokeLinecap:'round', strokeLinejoin:'round' };
  return (
    <svg viewBox="0 0 80 120" width="72" height="108" style={{ flexShrink:0 }}>
      {/* Papers */}
      <g transform="translate(1,64) rotate(-18)"><rect width="24" height="32" rx="2" fill="#fff" stroke="#ddd" strokeWidth="1"/><line x1="4" y1="8" x2="20" y2="8" stroke="#e5e5e5" strokeWidth="1"/><line x1="4" y1="13" x2="17" y2="13" stroke="#e5e5e5" strokeWidth="1"/><line x1="4" y1="18" x2="21" y2="18" stroke="#e5e5e5" strokeWidth="1"/></g>
      <g transform="translate(5,67) rotate(-7)"><rect width="24" height="32" rx="2" fill="#F7F4EE" stroke="#ccc" strokeWidth="1"/></g>
      <g transform="translate(9,70) rotate(-1)"><rect width="24" height="32" rx="2" fill="#fff" stroke="#bbb" strokeWidth="1"/><line x1="4" y1="8" x2="19" y2="8" stroke="#e5e5e5" strokeWidth="1"/><line x1="4" y1="13" x2="15" y2="13" stroke="#e5e5e5" strokeWidth="1"/></g>
      {/* Body */}
      <path d="M28 65 Q22 73 21 92 Q20 106 22 114 L58 114 Q60 106 59 92 Q58 73 52 65 Z" fill="#6CAE75"/>
      <path d="M36 65 L40 75 L44 65" fill="none" stroke="#5a9c63" strokeWidth="1.5"/>
      {/* Arms */}
      <path d="M28 70 Q16 81 18 96" fill="none" stroke="#F4C2A1" strokeWidth="7" strokeLinecap="round"/>
      <path d="M52 70 Q63 79 61 94" fill="none" stroke="#F4C2A1" strokeWidth="7" strokeLinecap="round"/>
      {/* Neck */}
      <rect x="36.5" y="56" width="7" height="11" rx="3" fill="#F4C2A1"/>
      {/* Head */}
      <ellipse cx="40" cy="42" rx="14" ry="16" fill="#F4C2A1"/>
      {/* Hair */}
      <path d="M26 37 Q26 23 40 21 Q54 23 54 37 Q52 26 40 24 Q28 26 26 37 Z" fill="#4A2E1E"/>
      <path d="M26 35 Q23 47 26 56" stroke="#4A2E1E" strokeWidth="5" fill="none" strokeLinecap="round"/>
      <path d="M54 35 Q57 47 54 57" stroke="#4A2E1E" strokeWidth="5" fill="none" strokeLinecap="round"/>
      <path d="M35 22 Q32 14 37 11" stroke="#4A2E1E" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      {/* Glasses */}
      <circle cx="35.5" cy="42" r="5" fill="rgba(200,220,255,0.12)" stroke="#4A2E1E" strokeWidth="1.5"/>
      <circle cx="44.5" cy="42" r="5" fill="rgba(200,220,255,0.12)" stroke="#4A2E1E" strokeWidth="1.5"/>
      <line x1="40.5" y1="42" x2="39.5" y2="42" stroke="#4A2E1E" strokeWidth="1.5"/>
      <line x1="30" y1="41" x2="28" y2="40" stroke="#4A2E1E" strokeWidth="1.5"/>
      <line x1="50" y1="41" x2="52" y2="40" stroke="#4A2E1E" strokeWidth="1.5"/>
      {/* Eyes */}
      {expr === 'tired' ? (
        <><path d="M32.5 42.5 Q35.5 44.5 38.5 42.5" {...p}/><path d="M41.5 42.5 Q44.5 44.5 47.5 42.5" {...p}/><path d="M53 34 Q55.5 30 53 28 Q50.5 30 53 34 Z" fill="#A8D4E6"/></>
      ) : expr === 'celebrating' ? (
        <><path d="M32 42 Q35.5 40 38.5 42" {...p}/><path d="M41.5 42 Q44.5 40 47.5 42" {...p}/></>
      ) : (
        <><circle cx="35.5" cy="42" r="1.8" fill="#4A2E1E"/><circle cx="44.5" cy="42" r="1.8" fill="#4A2E1E"/><circle cx="36.4" cy="41" r="0.7" fill="#fff"/><circle cx="45.4" cy="41" r="0.7" fill="#fff"/></>
      )}
      {/* Eyebrows */}
      {(expr === 'focused' || expr === 'tired') ? (
        <><path d="M32 37 Q35.5 36 38.5 37" {...p} strokeWidth="1.8"/><path d="M41.5 37 Q44.5 36 47.5 37" {...p} strokeWidth="1.8"/></>
      ) : (
        <><path d="M32 37 Q35.5 35.5 38.5 37" {...p} strokeWidth="1.2"/><path d="M41.5 37 Q44.5 35.5 47.5 37" {...p} strokeWidth="1.2"/></>
      )}
      {/* Mouth */}
      {expr === 'happy' && <path d="M36 49 Q40 52 44 49" {...p} strokeWidth="1.8"/>}
      {expr === 'excited' && <path d="M35 48.5 Q40 53 45 48.5" {...p} strokeWidth="1.8"/>}
      {expr === 'focused' && <path d="M37 49.5 Q40 48.5 43 49.5" {...p} strokeWidth="1.5"/>}
      {expr === 'tired' && <path d="M37 49 Q40 47.5 43 49" {...p} strokeWidth="1.5"/>}
      {expr === 'celebrating' && <path d="M35 48 Q40 54.5 45 48" {...p} strokeWidth="2"/>}
      {/* Blush */}
      {(expr === 'happy' || expr === 'excited' || expr === 'celebrating') && (
        <><ellipse cx="31" cy="46" rx="3.5" ry="2" fill="#FFB5B5" opacity="0.45"/><ellipse cx="49" cy="46" rx="3.5" ry="2" fill="#FFB5B5" opacity="0.45"/></>
      )}
    </svg>
  );
}

export function ScreenTutorial() {
  const nav = useNav();
  const [step, setStep] = React.useState(0);

  const STEPS = [
    { expr:'happy',       speech:"Hi! I'm Munni — your finance assistant. I'll show you the key features. It only takes a minute!", noTarget:true },
    { expr:'excited',     speech:"New bank transactions need your review! Tap the Review card to check and categorize them.", targetHint:'Review transactions' },
    { expr:'focused',     speech:"Once you're happy with the category, tap Confirm. You can bulk-apply to similar transactions too!", targetHint:'Confirm' },
    { expr:'excited',     speech:"The Allocate section shows your spending plan. Set budgets per topic and track your progress!", targetHint:'Allocate' },
    { expr:'focused',     speech:"Set your period start day to match when your salary lands — keeps income and expenses in sync.", targetHint:'Manage Periods' },
    { expr:'celebrating', speech:"You're all set! Explore munni and remember — I'm always here if you need help. ðŸ’š", noTarget:true, isLast:true },
  ];
  const cur = STEPS[step];
  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));

  const Overlay = () => <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.58)', zIndex:8, pointerEvents:'none' }}/>;

  const Spotlight = ({ children, color, onClick }) => (
    <div onClick={onClick} className="m-tap" style={{ position:'relative', zIndex:9, cursor:'pointer', borderRadius:14 }}>
      {children}
      <div style={{ position:'absolute', inset:-5, borderRadius:18, border:`2.5px solid ${color || M.sage}`, opacity:0.7, animation:'munniPulse 1.4s ease-in-out infinite', pointerEvents:'none' }}/>
    </div>
  );

  return (
    <div className="m-screen" style={{ background:M.paper }}>
      <style>{`@keyframes munniPulse{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:.3;transform:scale(1.05)}}`}</style>
      <StatusBar/>

      {/* Mock screen area — fills flex space */}
      <div style={{ flex:1, position:'relative', overflow:'hidden' }}>

        {step === 0 && (
          <div style={{ height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'0 36px', textAlign:'center', gap:10 }}>
            <div style={{ width:68, height:68, borderRadius:20, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:4 }}>
              <I name="wallet" size={30} color={M.sage}/>
            </div>
            <div style={{ fontSize:22, fontWeight:700, color:M.ink, lineHeight:1.3 }}>Welcome to munni</div>
            <div style={{ fontSize:13, color:M.ink3, lineHeight:1.7, maxWidth:250 }}>Your smart personal finance companion — built around the way you actually get paid.</div>
          </div>
        )}

        {step === 1 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 10px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Home</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div style={{ padding:'12px 16px', borderRadius:14, background:M.card, border:`1px solid ${M.line}`, marginBottom:10, opacity:0.25 }}>
                <div style={{ fontSize:12, color:M.ink3 }}>Feb 2026 · Period overview</div>
              </div>
              <Spotlight color={M.sage} onClick={next}>
                <div style={{ borderRadius:14, background:M.sage, padding:'14px 18px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:36, height:36, borderRadius:11, background:'rgba(255,255,255,0.22)', display:'flex', alignItems:'center', justifyContent:'center' }}><I name="check" size={18} color="#fff" stroke={2.5}/></div>
                  <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:700, color:'#fff' }}>Review transactions</div><div style={{ fontSize:12, color:'rgba(255,255,255,0.85)', marginTop:1 }}>7 waiting</div></div>
                  <I name="arrowR" size={15} color="rgba(255,255,255,0.7)"/>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 8px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Review · 1/7</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div className="m-card" style={{ padding:18, border:`1px solid ${M.line}`, background:'#fff', marginBottom:10, opacity:0.35 }}>
                <div style={{ textAlign:'center' }}>
                  <div className="m-num" style={{ fontSize:26, fontWeight:600 }}>âˆ’â‚¬34.99</div>
                  <div style={{ fontSize:14, fontWeight:600, marginTop:6 }}>Amazon.nl</div>
                  <div style={{ marginTop:10, padding:'8px 10px', borderRadius:10, background:M.paper2 }}>
                    <div style={{ display:'flex', gap:8, alignItems:'center' }}><div style={{ width:22, height:22, borderRadius:7, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="box" size={11} color={M.sage}/></div><div style={{ fontSize:12 }}>Hobby · â‚¬34.99</div></div>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding:'0 20px', flexShrink:0, position:'relative', zIndex:9 }}>
              <Spotlight color={M.sage} onClick={next}>
                <div style={{ height:50, borderRadius:14, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                  <I name="check" size={18} color="#fff" stroke={2.5}/>
                  <span style={{ fontSize:14, fontWeight:600, color:'#fff', fontFamily:M.fontUI }}>Confirm</span>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 10px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Home</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div style={{ padding:'12px 16px', borderRadius:14, background:M.card, border:`1px solid ${M.line}`, marginBottom:10, opacity:0.25 }}>
                <div style={{ fontSize:12, color:M.ink3 }}>Period balance · +â‚¬320</div>
              </div>
              <Spotlight color={M.violet} onClick={next}>
                <div style={{ borderRadius:14, background:M.card, border:`1px solid ${M.line}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:36, height:36, borderRadius:11, background:M.violetSoft||'#EEE8FF', display:'flex', alignItems:'center', justifyContent:'center' }}><I name="wallet" size={18} color={M.violet}/></div>
                  <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:600 }}>Allocate</div><div style={{ fontSize:12, color:M.ink3, marginTop:1 }}>â‚¬340 left to plan</div></div>
                  <I name="arrowR" size={14} color={M.ink4}/>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 10px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Profile</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div style={{ padding:'12px 16px', borderRadius:14, background:M.card, border:`1px solid ${M.line}`, marginBottom:10, opacity:0.25 }}>
                <div style={{ fontSize:12, color:M.ink3 }}>Manage · Categories</div>
              </div>
              <Spotlight color={M.ochre} onClick={next}>
                <div style={{ borderRadius:14, background:M.card, border:`1px solid ${M.line}`, padding:'13px 16px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:34, height:34, borderRadius:10, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="cal" size={16} color={M.ochre}/></div>
                  <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:500 }}>Manage Periods</div><div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>Set salary start day</div></div>
                  <I name="arrowR" size={14} color={M.ink4}/>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 5 && (
          <div style={{ height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'0 36px', textAlign:'center', gap:8 }}>
            <div style={{ fontSize:52, lineHeight:1 }}>ðŸŽ‰</div>
            <div style={{ fontSize:22, fontWeight:700, color:M.ink, marginTop:4 }}>You're all set!</div>
            <div style={{ fontSize:13, color:M.ink3, lineHeight:1.7, maxWidth:250 }}>Explore munni — and come back to this tutorial anytime from your Profile.</div>
          </div>
        )}
      </div>

      {/* Bottom: Munni + speech bubble */}
      <div style={{ flexShrink:0, padding:'8px 20px 28px', background:M.paper, borderTop:`1px solid ${M.line2}` }}>
        <div style={{ display:'flex', justifyContent:'center', gap:5, marginBottom:12 }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{ width: i===step ? 20 : 6, height:6, borderRadius:999, background: i===step ? M.sage : i<step ? M.sage+'66' : M.line2, transition:'all 0.3s' }}/>
          ))}
        </div>

        <div style={{ display:'flex', alignItems:'flex-end', gap:10 }}>
          <MunniSVG expr={cur.expr}/>
          <div style={{ flex:1, marginBottom:2 }}>
            <div style={{ background:'#fff', border:`1.5px solid ${M.line}`, borderRadius:16, padding:'11px 13px', marginBottom:10, fontSize:13, color:M.ink, lineHeight:1.6, boxShadow:'0 2px 10px rgba(0,0,0,0.05)', position:'relative' }}>
              {cur.speech}
              <div style={{ position:'absolute', left:-8, bottom:13, width:0, height:0, borderTop:'5px solid transparent', borderBottom:'5px solid transparent', borderRight:`8px solid ${M.line}` }}/>
              <div style={{ position:'absolute', left:-6, bottom:14, width:0, height:0, borderTop:'4px solid transparent', borderBottom:'4px solid transparent', borderRight:'7px solid #fff' }}/>
            </div>
            {cur.noTarget ? (
              <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={cur.isLast ? () => nav.pop() : next}>
                {cur.isLast ? <><I name="check" size={14} color="#fff" stroke={2.5}/> Done</> : "Let's go â†’"}
              </button>
            ) : (
              <div style={{ fontSize:12, color:M.ink4, textAlign:'center', fontStyle:'italic' }}>
                Tap <strong style={{ color:M.ink3, fontStyle:'normal' }}>{cur.targetHint}</strong> above to continue
              </div>
            )}
          </div>
        </div>

        {step < STEPS.length - 1 && (
          <button onClick={() => nav.pop()} style={{ display:'block', margin:'10px auto 0', background:'none', border:'none', fontSize:12, color:M.ink4, cursor:'pointer', fontFamily:M.fontUI, padding:'4px 16px' }}>
            Skip tutorial
          </button>
        )}
      </div>
    </div>
  );
}

function ScopeSelector({ scope, setScope, profiles }) {
  const allProfiles = profiles.filter(p => !p.isDemo);
  return (
    <>
      <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Available in</div>
      <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:16 }}>
        {/* All private spaces — independent checkbox */}
        <button data-testid="scope-all-private" className="m-tap" onClick={() => setScope(s => ({ ...s, allPrivate: !s.allPrivate }))}
          style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:10, border:`1.5px solid ${scope.allPrivate?M.sage:M.line}`, background:scope.allPrivate?M.sageSoft:M.paper2, cursor:'pointer', fontFamily:M.fontUI, textAlign:'left' }}>
          <div style={{ width:18, height:18, borderRadius:4, border:`2px solid ${scope.allPrivate?M.sage:M.ink4}`, background:scope.allPrivate?M.sage:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
            {scope.allPrivate && <I name="check" size={10} color="#fff"/>}
          </div>
          <div>
            <div style={{ fontSize:13, fontWeight:500, color:M.ink }}>All private spaces</div>
            <div style={{ fontSize:11, color:M.ink3 }}>Visible in all your personal spaces</div>
          </div>
        </button>
        {/* Individual spaces — independently selectable */}
        {allProfiles.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:200, overflowY:'auto' }}>
            {allProfiles.map(p => {
              const selected = (scope.spaces || []).includes(p.id);
              const avatar = p.emoji || p.avatar;
              return (
                <button key={p.id} data-testid={`scope-space-${p.id}`} className="m-tap" onClick={() => setScope(s => ({ ...s, spaces: selected ? (s.spaces||[]).filter(id=>id!==p.id) : [...(s.spaces||[]), p.id] }))}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:10, border:`1.5px solid ${selected?M.sage:M.line}`, background:selected?M.sageSoft:M.paper2, cursor:'pointer', fontFamily:M.fontUI, textAlign:'left' }}>
                  <div style={{ width:18, height:18, borderRadius:4, border:`2px solid ${selected?M.sage:M.ink4}`, background:selected?M.sage:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {selected && <I name="check" size={10} color="#fff"/>}
                  </div>
                  {avatar && <span style={{ fontSize:16 }}>{avatar}</span>}
                  <div style={{ fontSize:13, fontWeight:500, color:M.ink, flex:1 }}>{p.localName || p.name || p.displayName || 'Space'}</div>
                  {p.isShared && <span style={{ fontSize:9, padding:'2px 5px', borderRadius:4, background:M.ochreSoft, color:M.ochre, fontWeight:700 }}>SHARED</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function NewCatForm({ onSave, isSub = false }) {
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState('help-circle-outline');
  const [color, setColor] = React.useState(M.slate);
  const [scope, setScope] = React.useState({ allPrivate: true, spaces: [] });
  const { profiles } = useProfiles();
  const mdiIcons = [
    'help-circle-outline','home-outline','car-outline','heart-outline','star-outline',
    'food-outline','cart-variant','coffee-outline','television-play','hospital-box-outline',
    'shopping-outline','island','school-outline','dumbbell','baby-face-outline',
    'cash-plus','piggy-bank-outline','cellphone-link','gift-outline','book-education-outline',
    'briefcase-outline','bus-side','airplane-takeoff','medication-outline','paw-outline',
  ];
  const colors = [M.sage, M.clay, M.ochre, M.violet, M.slate, '#e07b39', '#6b8e6b', '#8e6b8e'];
  return (
    <div style={{ paddingBottom:8 }}>
      <input
        value={name} onChange={e => setName(e.target.value)}
        placeholder="Category name"
        style={{ width:'100%', boxSizing:'border-box', border:`1px solid ${M.line}`, borderRadius:10, padding:'11px 14px', fontSize:14, fontFamily:M.fontUI, marginBottom:14, outline:'none', background:M.paper2, color:M.ink }}
      />
      <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Icon</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14 }}>
        {mdiIcons.map(ic => (
          <button key={ic} className="m-tap" onClick={() => setIcon(ic)}
            style={{ width:36, height:36, borderRadius:8, background: icon===ic?M.sageSoft:M.paper2, border:`1.5px solid ${icon===ic?M.sage:M.line}`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
            <IcoMDI name={ic} size={15} color={icon===ic?M.sage:M.ink3}/>
          </button>
        ))}
      </div>
      {!isSub && (
        <>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Color</div>
          <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
            {colors.map(clr => (
              <button key={clr} className="m-tap" onClick={() => setColor(clr)}
                style={{ width:28, height:28, borderRadius:'50%', background:clr, border:`2.5px solid ${color===clr?M.ink:'transparent'}`, cursor:'pointer' }}/>
            ))}
          </div>
        </>
      )}
      <ScopeSelector scope={scope} setScope={setScope} profiles={profiles}/>
      <button className="m-tap" onClick={() => name.trim() && onSave(name.trim(), icon, color, scope)}
        disabled={!name.trim()}
        style={{ width:'100%', background:M.sage, border:'none', borderRadius:12, padding:'13px', color:'#fff', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, opacity: name.trim()?1:0.5 }}>
        {isSub ? 'Add sub-category' : 'Add category'}
      </button>
    </div>
  );
}

function EditCatSheet({ entry, txCount = 0, onSave, onDelete, isPrebuilt = false }) {
  const [nameDraft, setNameDraft] = React.useState(entry.name);
  const [iconDraft, setIconDraft] = React.useState(entry.icon || 'help-circle-outline');
  const { profiles } = useProfiles();
  // Normalize scope: handle old format (string or array) and new format ({ allPrivate, spaces })
  const normalizeScope = (sc) => {
    if (!sc) return { allPrivate: true, spaces: [] };
    if (typeof sc === 'object' && !Array.isArray(sc)) return sc;
    if (sc === 'all_private') return { allPrivate: true, spaces: [] };
    if (Array.isArray(sc)) return { allPrivate: false, spaces: sc };
    return { allPrivate: true, spaces: [] };
  };
  const [scopeDraft, setScopeDraft] = React.useState(() => normalizeScope(entry.scope));
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const canDelete = onDelete !== null;
  const isParent = entry.isParent;
  const mdiIcons = [
    'help-circle-outline','home-outline','car-outline','heart-outline','star-outline',
    'food-outline','cart-variant','coffee-outline','television-play','hospital-box-outline',
    'shopping-outline','island','school-outline','dumbbell','baby-face-outline',
    'cash-plus','piggy-bank-outline','cellphone-link','gift-outline','book-education-outline',
    'briefcase-outline','bus-side','airplane-takeoff','medication-outline','paw-outline',
  ];
  if (showDeleteConfirm) {
    return (
      <div style={{ padding:'4px 16px 8px' }}>
        <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>Delete "{entry.name}"?</div>
        {txCount > 0 && (
          <div style={{ padding:'10px 14px', borderRadius:10, background:M.claySoft, marginBottom:14, fontSize:13, color:M.clay, lineHeight:1.5 }}>
            <strong>{txCount} transaction{txCount!==1?'s':''}</strong> using this category will be set to Uncategorized.
          </div>
        )}
        <div style={{ fontSize:13, color:M.ink3, marginBottom:20, lineHeight:1.5 }}>This action cannot be undone.</div>
        <button onClick={onDelete} style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>Delete</button>
        <button onClick={() => setShowDeleteConfirm(false)} style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>Cancel</button>
      </div>
    );
  }
  return (
    <div style={{ padding:'4px 16px 8px' }}>
      <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{isParent ? 'Edit category' : 'Edit sub-category'}</div>
      <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Name</div>
      {isPrebuilt ? (
        <div style={{ padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, marginBottom:8, color:M.ink }}>{nameDraft}</div>
      ) : (
        <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
          style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:14 }}/>
      )}
      {isPrebuilt && <div style={{ fontSize:11, color:M.ink3, marginBottom:16, paddingLeft:2 }}>Built-in category names cannot be changed.</div>}
      {!isPrebuilt && (
        <>
          {/* Icon picker (Change 13) */}
          <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Icon</div>
          <div data-testid="edit-cat-icon-picker" style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14 }}>
            {mdiIcons.map(ic => (
              <button key={ic} className="m-tap" onClick={() => setIconDraft(ic)}
                style={{ width:36, height:36, borderRadius:8, background: iconDraft===ic?M.sageSoft:M.paper2, border:`1.5px solid ${iconDraft===ic?M.sage:M.line}`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                <IcoMDI name={ic} size={15} color={iconDraft===ic?M.sage:M.ink3}/>
              </button>
            ))}
          </div>
          {/* Scope (Change 14) */}
          <ScopeSelector scope={scopeDraft} setScope={setScopeDraft} profiles={profiles}/>
        </>
      )}
      <button onClick={() => nameDraft.trim() && onSave(nameDraft.trim(), iconDraft, entry.color, scopeDraft)}
        style={{ width:'100%', padding:'14px 0', background:nameDraft.trim()?M.sage:M.line, color:nameDraft.trim()?'#fff':M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:nameDraft.trim()?'pointer':'default', fontFamily:M.fontUI, marginBottom:canDelete?12:10 }}>
        Save
      </button>
      {canDelete && (
        <>
          {txCount > 0 && <div style={{ fontSize:12, color:M.ochre, marginBottom:8, textAlign:'center' }}>{txCount} transaction{txCount!==1?'s':''} will be set to uncategorized</div>}
          <button onClick={() => setShowDeleteConfirm(true)}
            style={{ width:'100%', padding:'14px 0', background:'transparent', color:M.clay, border:`1.5px solid ${M.clay}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            Delete category
          </button>
        </>
      )}
    </div>
  );
}

export function ScreenManageCategories() {
  const nav = useNav();
  const { t } = useLang();
  const { txs, setTxs } = useTxCtx();
  const { customCats, setCustomCats } = useCatCtx();
  const [premadeOverrides, setPremadeOverrides] = useLocalStorage('munni_cat_overrides', {});
  const [newParentSheet, setNewParentSheet] = React.useState(false);
  const [newSubSheet, setNewSubSheet] = React.useState(null);
  const [dragState, setDragState] = React.useState(null);
  const [dropTarget, setDropTarget] = React.useState(null);
  const [editSheet, setEditSheet] = React.useState(null);
  const [collapsedParents, setCollapsedParents] = React.useState({});
  const [txCounts, setTxCounts] = React.useState({});

  React.useEffect(() => {
    const counts = {};
    txs.forEach(t => {
      if (t.cat) counts[t.cat] = (counts[t.cat] || 0) + 1;
    });
    setTxCounts(counts);
  }, [txs]);

  // Helpers
  const customParents = customCats.filter(c => c.isParent);
  const premadeParents = Object.entries(CATEGORIES).filter(([k,v]) => v.isParent && !v.positive && k !== 'saving' && k !== 'expense');

  const getCustomSubs = (parentId) => customCats.filter(c => !c.isParent && c.parent === parentId);
  const getPremadeSubs = (parentKey) => Object.entries(CATEGORIES).filter(([k,v]) => v.parent === parentKey);
  const getCustomSubsOfPremade = (parentKey) => customCats.filter(c => !c.isParent && c.parent === parentKey);

  const deleteCustomSub = (catId) => {
    setCustomCats(prev => prev.filter(c => c.id !== catId));
    setTxs(prev => prev.map(t => {
      if (t.cat === catId) {
        const fallback = (t.amount >= 0) ? 'incomeUncategorized' : 'expenseUncategorized';
        return { ...t, cat: fallback, cats: [{ catId: fallback, amount: Math.abs(t.amount) }] };
      }
      return t;
    }));
  };

  const deleteCustomParent = (parentId) => {
    const subsToDelete = new Set(customCats.filter(c => c.parent === parentId).map(c => c.id));
    subsToDelete.add(parentId);
    setCustomCats(prev => prev.filter(c => !subsToDelete.has(c.id) && c.parent !== parentId));
    setTxs(prev => prev.map(t => {
      if (subsToDelete.has(t.cat) || t.cat === parentId) {
        const fallback = (t.amount >= 0) ? 'incomeUncategorized' : 'expenseUncategorized';
        return { ...t, cat: fallback, cats: [{ catId: fallback, amount: Math.abs(t.amount) }] };
      }
      return t;
    }));
  };

  const canDeleteParent = (parentId) => {
    const subs = getCustomSubs(parentId);
    return subs.length === 1 && subs[0].id === `${parentId}_other`;
  };

  const startDrag = (e, catId, parentId, label, icon, color) => {
    e.preventDefault();
    e.stopPropagation();
    setDragState({ catId, parentId, x: e.clientX, y: e.clientY, ghostLabel: label, ghostIcon: icon, ghostColor: color });
    setCollapsedParents(() => {
      const next = {};
      [...Object.values(CATEGORIES).filter(c => c.isParent), ...customCats.filter(c => c.isParent)].forEach(p => { next[p.id] = true; });
      return next;
    });
  };

  const moveDrag = (e) => {
    if (!dragState) return;
    setDragState(d => d ? { ...d, x: e.clientX, y: e.clientY } : null);
    const scrollEl = document.querySelector('.m-body-scroll');
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      if (e.clientY > rect.bottom - 60) scrollEl.scrollTop += 6;
      else if (e.clientY < rect.top + 60) scrollEl.scrollTop -= 6;
    }
  };

  const endDrag = () => {
    if (!dragState || !dropTarget) { setDragState(null); setDropTarget(null); setCollapsedParents({}); return; }
    const { catId } = dragState;
    let destParentId = null;
    if (dropTarget.type === 'parent') {
      destParentId = dropTarget.parentId;
      setCustomCats(prev => prev.map(c => c.id === catId ? { ...c, parent: dropTarget.parentId } : c));
    } else if (dropTarget.type === 'reorder' && dropTarget.catId !== catId) {
      destParentId = dropTarget.parentId;
      setCustomCats(prev => {
        const subs = prev.filter(c => !c.isParent && c.parent === dropTarget.parentId);
        const others = prev.filter(c => c.isParent || c.parent !== dropTarget.parentId);
        const dragIdx = subs.findIndex(c => c.id === catId);
        const targetIdx = subs.findIndex(c => c.id === dropTarget.catId);
        if (dragIdx < 0 || targetIdx < 0) return prev;
        const reordered = [...subs];
        const [item] = reordered.splice(dragIdx, 1);
        reordered.splice(targetIdx, 0, item);
        return [...others, ...reordered];
      });
    }
    setDragState(null);
    setDropTarget(null);
    setCollapsedParents({});
    // Scroll to and flash the destination parent
    if (destParentId && destParentId !== dragState.parentId) {
      setTimeout(() => {
        const el = parentRefs.current[destParentId];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setFlashCatId(catId);
        setTimeout(() => setFlashCatId(null), 1000);
      }, 50);
    }
  };

  const [flashCatId, setFlashCatId] = React.useState(null);
  const parentRefs = React.useRef({});

  const renderParentCard = (parentKey, parentCat, isCustom) => {
    const premadeSubs = isCustom ? [] : getPremadeSubs(parentKey);
    const customSubsHere = isCustom ? getCustomSubs(parentKey) : getCustomSubsOfPremade(parentKey);
    const rawSubs = isCustom ? customSubsHere : [...premadeSubs, ...customSubsHere];
    // 'other' always last
    const otherSub = rawSubs.find(s => (Array.isArray(s) ? false : s.id === `${parentKey}_other`));
    const nonOther = rawSubs.filter(s => !(Array.isArray(s) ? false : s.id === `${parentKey}_other`));
    const allSubs = otherSub ? [...nonOther, otherSub] : nonOther;
    const subCount = allSubs.length;
    const isCollapsed = !!collapsedParents[parentKey];
    const isDropTarget = dropTarget?.type === 'parent' && dropTarget.parentId === parentKey;

    return (
      <div key={parentKey} ref={el => parentRefs.current[parentKey] = el}
        data-parentkey={parentKey}
        className="m-card"
        style={{ marginBottom:12, border:`1.5px solid ${isDropTarget ? (parentCat.color || M.sage) : M.line}`, borderRadius:14, overflow:'hidden', background: isDropTarget ? (parentCat.color ? parentCat.color + '11' : M.sageSoft) : 'transparent', transition:'border-color 0.15s, background 0.15s' }}
        onPointerEnter={dragState ? () => setDropTarget({ type:'parent', parentId: parentKey }) : undefined}
      >
        {/* Parent header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:M.paper }}>
          <div style={{ width:38, height:38, borderRadius:10, background:parentCat.color||M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={parentCat.icon||'help-circle-outline'} size={18} color={isCustom?'#fff':M.ink2}/>
          </div>
          <div className={isCustom ? 'm-tap' : ''} style={{ flex:1, cursor: isCustom ? 'pointer' : 'default' }}
            onClick={isCustom ? () => setEditSheet({ catId: parentKey, parentId: null, isCustom:true, isParent: true, name: parentCat.name, icon: parentCat.icon || 'help-circle-outline', color: parentCat.color, scope: parentCat.scope }) : undefined}
          >
            <div style={{ fontSize:15, fontWeight:600 }}>{parentCat.name}</div>
            {isCustom && parentCat.scope && (() => {
              const sc = parentCat.scope;
              const parts = [];
              const isNew = sc && typeof sc === 'object' && !Array.isArray(sc);
              if (isNew) {
                if (sc.allPrivate) parts.push('All private');
                if ((sc.spaces||[]).length > 0) parts.push(`+${sc.spaces.length} space${sc.spaces.length!==1?'s':''}`);
              } else if (sc === 'all_private') {
                parts.push('All private spaces');
              } else if (Array.isArray(sc) && sc.length > 0) {
                parts.push(`${sc.length} space${sc.length!==1?'s':''}`);
              }
              return parts.length ? <div style={{ fontSize:10, color:M.ink4, marginTop:1 }}>{parts.join(' ')}</div> : null;
            })()}
          </div>
          <span style={{ fontSize:12, color:M.ink3 }}>{subCount} subs</span>
          <button className="m-tap" onClick={() => setCollapsedParents(prev => ({ ...prev, [parentKey]: !prev[parentKey] }))}
            style={{ background:'none', border:'none', cursor:'pointer', padding:4, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition:'transform 0.2s ease', display:'flex' }}>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          </button>
        </div>
        {/* Sub-categories */}
        <div style={{ overflow:'hidden', maxHeight: isCollapsed ? 0 : 9999, transition:'max-height 0.35s ease' }}>
          {allSubs.map((sub) => {
            const subKey = Array.isArray(sub) ? sub[0] : sub.id;
            const subCat = Array.isArray(sub) ? sub[1] : sub;
            const isCustomSub = !Array.isArray(sub);
            const isOther = isCustomSub && sub.id === `${parentKey}_other`;
            // 'other' uses parent color same as other custom subs
            const subBg = parentCat.color ? parentCat.color + '33' : M.paper2;
            const subIconColor = parentCat.color || M.ink2;
            const isFlashing = flashCatId === subKey;

            return (
              <div key={subKey}
                className={isCustomSub && !isOther ? 'm-tap' : ''}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 16px', borderTop:`1px solid ${M.line2}`,
                  background: isFlashing ? (parentCat.color || M.sage) + '22' : dropTarget?.catId === subKey ? M.sageSoft : 'transparent',
                  transition:'background 0.3s',
                  cursor: (isCustomSub && !isOther) ? 'grab' : 'default',
                  touchAction: (isCustomSub && !isOther) ? 'none' : 'auto',
                }}
                onClick={isCustomSub && !isOther ? () => setEditSheet({ catId: subKey, parentId: parentKey, isCustom: true, isParent: false, name: subCat.name, icon: subCat.icon || 'help-circle-outline', scope: subCat.scope }) : undefined}
                onPointerDown={(isCustomSub && !isOther) ? (e) => startDrag(e, subKey, parentKey, subCat.name, subCat.icon, parentCat.color || M.paper2) : undefined}
                onPointerEnter={(dragState && !isOther) ? () => setDropTarget({ type:'reorder', catId: subKey, parentId: parentKey }) : undefined}
              >
                <div style={{ width:28, height:28, borderRadius:8, background: isOther ? (parentCat.color ? parentCat.color+'33' : M.paper2) : subBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <IcoMDI name={subCat.icon||'help-circle-outline'} size={13} color={isOther ? (parentCat.color || M.ink3) : subIconColor}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:isOther?400:500, color:isOther?M.ink3:M.ink, fontStyle:isOther?'italic':'normal' }}>{subCat.name}</div>
                </div>
                {(isCustomSub && !isOther) && (
                  <div style={{ opacity:0.35, flexShrink:0 }}>
                    <I name="menu" size={13} color={M.ink3}/>
                  </div>
                )}
              </div>
            );
          })}
          {/* +Sub button at bottom, after 'other' */}
          <button className="m-tap" onClick={() => setNewSubSheet(parentKey)}
            style={{ width:'100%', padding:'10px 16px', borderTop:`1px solid ${M.line2}`, background:'transparent', border:'none', borderTopStyle:'solid', borderTopWidth:1, borderTopColor:M.line2, display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontFamily:M.fontUI, color:M.sage }}>
            <I name="plus" size={13} color={M.sage}/>
            <span style={{ fontSize:13, fontWeight:500 }}>Add sub-category</span>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="m-screen"
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <StatusBar/>
      <AppBar title={t('screen.categories')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-tap m-iconbtn" onClick={() => setNewParentSheet(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">

        {/* CUSTOM section */}
        {customParents.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8 }}>CUSTOM · {customParents.length}</div>
            {customParents.map(p => renderParentCard(p.id, p, true))}
          </>
        )}

        {/* PREMADE section */}
        <div className="m-cap" style={{ marginBottom:8, marginTop: customParents.length>0?16:0 }}>PREMADE CATEGORIES</div>
        {premadeParents.map(([k,v]) => renderParentCard(k, v, false))}

        <div style={{ height:32 }}/>
      </div>

      {/* New parent sheet */}
      <Sheet open={newParentSheet} onClose={() => setNewParentSheet(false)} title="New parent category">
        <NewCatForm
          onSave={(name, icon, color, scope) => {
            const id = `cust_${Date.now()}`;
            setCustomCats(prev => [...prev,
              { id, name, icon: icon||'box', color: color||M.slate, isParent:true, parent:null, scope: scope || 'all_private' },
              { id:`${id}_other`, name:'Other', icon:'dots-horizontal', color:M.paper2, isParent:false, parent:id, scope: scope || 'all_private' }
            ]);
            setNewParentSheet(false);
          }}
        />
      </Sheet>

      {/* New sub sheet */}
      <Sheet open={!!newSubSheet} onClose={() => setNewSubSheet(null)} title="New sub-category">
        <NewCatForm
          isSub={true}
          onSave={(name, icon, color, scope) => {
            const parentId = newSubSheet;
            setCustomCats(prev => [...prev,
              { id:`cust_${Date.now()}`, name, icon: icon||'box', color: color||M.slate, isParent:false, parent:parentId, scope: scope || 'all_private' }
            ]);
            setNewSubSheet(null);
          }}
        />
      </Sheet>

      {/* Edit sheet */}
      {editSheet && (
        <Sheet onClose={() => setEditSheet(null)}>
          <EditCatSheet
            entry={editSheet}
            txCount={txCounts[editSheet.catId] || 0}
            isPrebuilt={!editSheet.isCustom}
            onSave={(name, icon, color, scope) => {
              if (editSheet.isCustom) {
                setCustomCats(prev => prev.map(c => c.id === editSheet.catId ? { ...c, name, icon, color, scope } : c));
              } else {
                setPremadeOverrides(prev => ({ ...prev, [editSheet.catId]: { name } }));
              }
              setEditSheet(null);
            }}
            onDelete={editSheet.isCustom ? () => {
              if (editSheet.isParent) {
                deleteCustomParent(editSheet.catId);
              } else {
                deleteCustomSub(editSheet.catId);
              }
              setEditSheet(null);
            } : null}
          />
        </Sheet>
      )}

      {/* Floating drag ghost */}
      {dragState && (
        <div style={{
          position:'fixed',
          left: dragState.x - 60,
          top: dragState.y - 22,
          transform: 'translateY(-50%)',
          zIndex: 9999,
          pointerEvents: 'none',
          display:'flex', alignItems:'center', gap:8,
          padding:'8px 14px',
          borderRadius:12,
          background: M.card,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          border:`1.5px solid ${dragState.ghostColor || M.line}`,
          opacity: 0.95,
          minWidth: 120,
        }}>
          <div style={{ width:28, height:28, borderRadius:8, background: dragState.ghostColor || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={dragState.ghostIcon || 'help-circle-outline'} size={13} color="#fff"/>
          </div>
          <div style={{ fontSize:13, fontWeight:600 }}>{dragState.ghostLabel}</div>
        </div>
      )}
    </div>
  );
}

export function InviteCards() {
  const { t } = useLang();
  const myId = React.useMemo(() => getUserId(), []);
  const [invitations, setInvitations] = useLocalStorage('munni_global_invitations', []);
  const [friendships, setFriendships] = useLocalStorage('munni_global_friendships', []);
  const [userRegistry] = useLocalStorage('munni_global_users', {});
  const [blocks, setBlocks] = useLocalStorage('munni_global_blocks', {});
  const { profiles, setProfiles } = useProfiles();
  const [declineSheet, setDeclineSheet] = React.useState(null); // { inv, isProfile, onJustDecline }
  const [renameInviteSheet, setRenameInviteSheet] = React.useState(null);

  const myBlockedSenderIds = new Set((blocks[myId] || []).map(b => b.userId));
  const pendingFriend = invitations.filter(inv => inv.toId === myId && inv.type === 'friend' && inv.status === 'pending' && !myBlockedSenderIds.has(inv.fromId));
  const pendingProfile = invitations.filter(inv => inv.toId === myId && inv.type === 'profile' && inv.status === 'pending' && !myBlockedSenderIds.has(inv.fromId));
  const allPending = [...pendingFriend, ...pendingProfile];

  // Slide-in animation for invites that arrive while the screen is already open
  const seenIdsRef = React.useRef(null);
  const [animatingIds, setAnimatingIds] = React.useState(new Set());
  React.useEffect(() => {
    const currentIds = new Set(allPending.map(i => i.id));
    if (seenIdsRef.current === null) { seenIdsRef.current = currentIds; return; }
    const newIds = allPending.filter(i => !seenIdsRef.current.has(i.id)).map(i => i.id);
    seenIdsRef.current = currentIds;
    if (newIds.length === 0) return;
    setAnimatingIds(prev => new Set([...prev, ...newIds]));
    const timer = setTimeout(() => setAnimatingIds(prev => { const n = new Set(prev); newIds.forEach(id => n.delete(id)); return n; }), 500);
    return () => clearTimeout(timer);
  }, [allPending.map(i => i.id).join(',')]);

  if (pendingFriend.length === 0 && pendingProfile.length === 0) return null;

  const respondFriend = (inv, action) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: action } : i));
    if (action === 'accepted') {
      setFriendships(list => {
        const exists = list.some(f => f.users && f.users.includes(inv.fromId) && f.users.includes(myId));
        if (exists) return list;
        return [...list, { id: `fr_${Date.now()}`, users: [inv.fromId, myId], since: Date.now() }];
      });
    }
  };

  const declineAndBlock = (inv) => {
    // Remove invite entirely so sender sees nothing (not even "declined")
    setInvitations(list => list.filter(i => i.id !== inv.id));
    const senderInfo = userRegistry[inv.fromId] || {};
    setBlocks(prev => {
      const existing = prev[myId] || [];
      if (existing.some(b => b.userId === inv.fromId)) return prev;
      return { ...prev, [myId]: [...existing, { userId: inv.fromId, displayName: senderInfo.displayName || inv.fromId, picture: senderInfo.picture || null, blockedAt: Date.now() }] };
    });
    setDeclineSheet(null);
  };

  const respondProfile = (inv, action, customName = null) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: action, respondedAt: Date.now() } : i));
    if (action === 'accepted') {
      // Clear any stale left/expelled signals for me in this profile's sharedData so
      // the owner's checkSharedSignals doesn't remove me immediately after rejoining
      try {
        const sdKey = `munni_shared_data_${inv.profileId}`;
        const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
        const hadStale = sd.left?.[myId] || sd.expelled?.[myId];
        if (hadStale) {
          const { [myId]: _l, ...remainingLeft } = sd.left || {};
          const { [myId]: _e, ...remainingExpelled } = sd.expelled || {};
          // Also pick up the latest name/picture from meta in case owner renamed since last invite
          localStorage.setItem(sdKey, JSON.stringify({ ...sd, left: remainingLeft, expelled: remainingExpelled }));
          window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
        }
        // Read fresh meta so the rejoined profile starts with the current name/picture
        const freshSd = JSON.parse(localStorage.getItem(sdKey) || '{}');
        var freshName = freshSd.meta?.name;
        var freshPic = freshSd.meta?.picture;
      } catch {}
      // Add a shared copy of the profile to the accepter's profile list
      setProfiles(ps => {
        const existing = ps.find(p => p.id === inv.profileId);
        const originalOwnerId = inv.originalOwnerId || inv.fromId;
        const ownerDisplay = userRegistry[originalOwnerId]?.displayName || originalOwnerId;
        const ownerName = freshName || inv.profileName || 'Shared';
        const trimmedCustom = customName?.trim();
        const profileData = {
          id: inv.profileId,
          name: ownerName,
          localName: trimmedCustom && trimmedCustom !== ownerName ? trimmedCustom : ownerName,
          icon: inv.profileIcon || 'users',
          active: false,
          accountIds: inv.profileAccountIds || [],
          picture: freshPic !== undefined ? freshPic : (inv.profilePicture || null),
          isDemo: inv.profileIsDemo || false,
          isShared: true,
          ownerId: originalOwnerId,
          ownerDisplay,
          members: [{ userId: originalOwnerId, displayName: ownerDisplay, permission: 'owner', accountIds: [] }],
        };
        if (existing) {
          // Rejoin: update the existing entry rather than skipping
          return ps.map(p => p.id === inv.profileId ? { ...p, ...profileData } : p);
        }
        return [...ps, profileData];
      });
    }
  };

  const renderFriendInvite = (inv, onAccept, onDeclineAction) => {
    const name = userRegistry[inv.fromId]?.displayName || inv.fromId;
    const pic = userRegistry[inv.fromId]?.picture;
    const av = pic?.startsWith('av') ? STOCK_AVATARS.find(a => a.id === pic) : null;
    return (
      <div style={{ padding:'14px 0' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
          <div style={{ width:44, height:44, borderRadius:999, background: av ? av.bg : M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' }}>
            {pic?.startsWith('data:')
              ? <img src={pic} style={{ width:44, height:44, objectFit:'cover' }}/>
              : av ? <span style={{ fontSize:22 }}>{av.emoji}</span>
              : <I name="user" size={20} color={M.sage}/>
            }
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:600 }}>{name}</div>
            <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono, marginTop:2 }}>{inv.fromId}</div>
          </div>
          <div style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase', letterSpacing:'0.04em', flexShrink:0 }}>{t('friends.friendBadge')}</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="m-tap" onClick={onAccept}
            style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.accept')}
          </button>
          <button className="m-tap" onClick={() => setDeclineSheet({ inv, isProfile: false, onJustDecline: onDeclineAction })}
            style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.decline')}
          </button>
        </div>
      </div>
    );
  };

  const renderProfileInvite = (inv, onAccept, onDeclineAction) => {
    const senderName = userRegistry[inv.fromId]?.displayName || inv.fromId;
    const senderPic = userRegistry[inv.fromId]?.picture;
    const senderAv = senderPic?.startsWith('av') ? STOCK_AVATARS.find(a => a.id === senderPic) : null;
    const fakeProfile = { name: inv.profileName, picture: inv.profilePicture || null };
    return (
      <div style={{ padding:'14px 0' }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:12 }}>
          <div style={{ position:'relative', flexShrink:0 }}>
            <ProfileAvatar profile={fakeProfile} size={48}/>
            {/* Sender badge */}
            <div style={{ position:'absolute', bottom:-4, right:-4, width:22, height:22, borderRadius:999, background: senderAv ? senderAv.bg : M.sageSoft, border:`2px solid ${M.paper}`, display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
              {senderPic?.startsWith('data:')
                ? <img src={senderPic} style={{ width:18, height:18, objectFit:'cover' }}/>
                : senderAv ? <span style={{ fontSize:10 }}>{senderAv.emoji}</span>
                : <I name="user" size={10} color={M.sage}/>
              }
            </div>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, fontWeight:700, color:M.sage, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>{t('space.inviteFrom')}</div>
            <div style={{ fontSize:15, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.profileName || 'Shared space'}</div>
            <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>From <strong>{senderName}</strong></div>
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="m-tap" onClick={onAccept}
            style={{ flex:2, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('space.inviteJoin')}
          </button>
          <button className="m-tap" onClick={onDeclineAction}
            style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.decline')}
          </button>
        </div>
      </div>
    );
  };

  const dsInv = declineSheet?.inv;
  const dsName = dsInv ? (userRegistry[dsInv.fromId]?.displayName || dsInv.fromId) : '';

  return (
    <>
      <style>{`@keyframes slideInNotif{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.pending')}</div>
      <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
        {allPending.map((inv, i) => (
          <React.Fragment key={inv.id}>
            {i > 0 && <Divider inset={0}/>}
            <div style={{ animation: animatingIds.has(inv.id) ? 'slideInNotif 0.38s cubic-bezier(0.16,1,0.3,1)' : 'none' }}>
              {inv.type === 'friend'
                ? renderFriendInvite(inv, () => respondFriend(inv, 'accepted'), () => respondFriend(inv, 'declined'))
                : renderProfileInvite(inv, () => setRenameInviteSheet({ inv, name: inv.profileName || '' }), () => respondProfile(inv, 'declined'))}
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* Rename-on-join sheet */}
      {renameInviteSheet && (
        <Sheet onClose={() => setRenameInviteSheet(null)}>
          <div style={{ padding:'4px 16px 20px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <ProfileAvatar profile={{ name: renameInviteSheet.inv.profileName, picture: renameInviteSheet.inv.profilePicture || null }} size={44}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{renameInviteSheet.inv.profileName || 'Shared space'}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>
                  {t('space.by')} <strong>{userRegistry[renameInviteSheet.inv.fromId]?.displayName || renameInviteSheet.inv.fromId}</strong>
                </div>
              </div>
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('space.nameThisSpace')}</div>
            <input autoFocus
              value={renameInviteSheet.name}
              onChange={e => setRenameInviteSheet(prev => ({ ...prev, name: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && (respondProfile(renameInviteSheet.inv, 'accepted', renameInviteSheet.name), setRenameInviteSheet(null))}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:6 }}
            />
            <div style={{ fontSize:11, color:M.ink4, marginBottom:20 }}>{t('space.nameThisSpaceHint')}</div>
            <button onClick={() => { respondProfile(renameInviteSheet.inv, 'accepted', renameInviteSheet.name); setRenameInviteSheet(null); }}
              style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('space.inviteJoin')}
            </button>
            <button onClick={() => setRenameInviteSheet(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {/* Decline options sheet */}
      {declineSheet && (
        <Sheet onClose={() => setDeclineSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:15, fontWeight:700, padding:'12px 0 4px', color:M.ink }}>{dsName}</div>
            <div style={{ fontSize:12, color:M.ink4, marginBottom:16 }}>{declineSheet.isProfile ? t('space.inviteFrom') : t('friends.inviteNotif')} {dsName}</div>
            <button className="m-tap" onClick={() => { declineSheet.onJustDecline(); setDeclineSheet(null); }}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="x" size={16} color={M.ink3}/>
              </div>
              <span style={{ fontSize:15, fontWeight:500, color:M.ink, fontFamily:M.fontUI }}>{t('friends.justDecline')}</span>
            </button>
            <button className="m-tap" onClick={() => declineAndBlock(declineSheet.inv)}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:'#FFF0F0', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="ban" size={16} color={M.clay}/>
              </div>
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:15, fontWeight:500, color:M.clay, fontFamily:M.fontUI }}>{t('friends.declineAndBlock')}</div>
                <div style={{ fontSize:11, color:M.ink4 }}>{dsName} {t('friends.blockAction').toLowerCase()}</div>
              </div>
            </button>
            <div style={{ height:8 }}/>
          </div>
        </Sheet>
      )}
    </>
  );
}

function fmtSyncTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)  return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
  } catch { return isoStr; }
}

export function ScreenNotifications() {
  const nav = useNav();
  const { t } = useLang();
  const { addTxs, txs } = useTxCtx();
  const [syncing, setSyncing] = React.useState(false);
  const syncKey = React.useMemo(() => getUserSyncKey(), []);
  const [lastSyncedStr, setLastSyncedStr] = useLocalStorage(syncKey, null);
  const [newCount, setNewCount] = React.useState(0);
  const [syncedReviewCount, setSyncedReviewCount] = React.useState(0);
  const [, setNotifUnread] = useLocalStorage('munni_notif_unread', 0);
  const { profiles } = useProfiles();
  const myId = React.useMemo(() => getUserId(), []);

  const coOwnerRequests = React.useMemo(() => {
    const result = [];
    profiles.filter(p => !p.isShared).forEach(p => {
      try {
        const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{}');
        (sd.accounts || []).forEach(acct => {
          (acct.coOwnerRequests || []).filter(r => r.status === 'pending').forEach(req => {
            result.push({ acct, req, spaceId: p.id, spaceName: p.localName || p.name });
          });
        });
      } catch {}
    });
    return result;
  }, [profiles]);

  const acceptCoOwnerRequest = (item) => {
    try {
      const sdKey = `munni_shared_data_${item.spaceId}`;
      const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      const accounts = (sd.accounts || []).map(a =>
        a.id === item.acct.id ? {
          ...a,
          coOwners: [...new Set([...(a.coOwners || []), item.req.userId])],
          coOwnerRequests: (a.coOwnerRequests || []).map(r => r.userId === item.req.userId ? { ...r, status: 'accepted' } : r),
        } : a
      );
      localStorage.setItem(sdKey, JSON.stringify({ ...sd, accounts }));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
    } catch {}
  };

  const denyCoOwnerRequest = (item) => {
    try {
      const sdKey = `munni_shared_data_${item.spaceId}`;
      const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      const accounts = (sd.accounts || []).map(a =>
        a.id === item.acct.id ? {
          ...a,
          coOwnerRequests: (a.coOwnerRequests || []).map(r => r.userId === item.req.userId ? { ...r, status: 'denied' } : r),
        } : a
      );
      localStorage.setItem(sdKey, JSON.stringify({ ...sd, accounts }));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
    } catch {}
  };

  React.useEffect(() => { setNotifUnread(0); }, []);

  const MERCHANTS_POOL = [
    { merchant:'Albert Heijn',       desc:'AH 5821',        cat:'groceries',       min:8,  max:85,  needsReview:true },
    { merchant:'Koffie â˜•',          desc:'TOKI ESPRESSO',  cat:'coffee',          min:3,  max:6,   needsReview:true },
    { merchant:'NS · Sprinter',      desc:'NS REIZIGERS',   cat:'transportPublic', min:4,  max:28,  needsReview:true },
    { merchant:'Etos',               desc:'ETOS 0341',      cat:'healthcare',      min:5,  max:35,  confidence:60, needsReview:true },
    { merchant:'Vapiano',            desc:'VAPIANO 1234',   cat:'restaurants',     min:12, max:38,  needsReview:true },
    { merchant:'Coolblue',           desc:'COOLBLUE ORDER', cat:'electronics',     min:29, max:199, confidence:55, needsReview:true },
    { merchant:'Apotheek Centraal',  desc:'APOTHEEK 7842',  cat:'prescription',    min:8,  max:40,  confidence:58, needsReview:true },
  ];

  const handleSync = () => {
    setSyncing(true);
    setTimeout(() => {
      const count = Math.floor(Math.random() * 5) + 1;
      const now = new Date();
      const newTxs = Array.from({ length: count }, (_, i) => {
        const pool = MERCHANTS_POOL[Math.floor(Math.random() * MERCHANTS_POOL.length)];
        const amt = -(Math.round((pool.min + Math.random() * (pool.max - pool.min)) * 100) / 100);
        const id = `tsync_${Date.now()}_${i}`;
        const dateStr = now.toISOString().slice(0, 10);
        const loginMethod = sessionStorage.getItem('munni_last_login_method') || '';
        const accountId = loginMethod === 'bank' ? 'demo_main' : 'main';
        return { id, date: dateStr, time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, merchant: pool.merchant, desc: pool.desc, cat: pool.cat, amount: amt, account: accountId, needsReview: true, ...(pool.confidence ? { confidence: pool.confidence } : {}) };
      });
      addTxs(newTxs);
      setNewCount(count);
      setSyncedReviewCount(count);
      setLastSyncedStr(now.toISOString());
      setSyncing(false);
    }, 1200);
  };


  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.notifications')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:16, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:14 }}>
            <div style={{ width:44, height:44, borderRadius:13, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="sync" size={20} color={M.sage}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:15, fontWeight:600 }}>{t('notif.bankSync')}</div>
              <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>{lastSyncedStr ? `${t('notif.lastSynced')} ${fmtSyncTime(lastSyncedStr)}` : t('notif.bankSyncSub')}</div>
            </div>
          </div>
          <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={handleSync} disabled={syncing}>
            {syncing ? (
              <><I name="sync" size={16} color="#fff"/> {t('notif.syncing')}</>
            ) : (
              <><I name="sync" size={16} color="#fff"/> {t('notif.syncNow')}</>
            )}
          </button>
          {newCount > 0 && (
            <div style={{ marginTop:10, borderRadius:10, overflow:'hidden', border:`1px solid ${M.ochreSoft}` }}>
              <div style={{ padding:'8px 12px', background:M.ochreSoft, fontSize:12, color:M.ochre, fontWeight:500 }}>
                {newCount === 1 ? t('notif.txSynced').replace('{n}','1') : t('notif.txsSynced').replace('{n}', newCount)}
              </div>
              <button className="m-tap" onClick={() => { setNewCount(0); nav.push('reviewSwipe'); }} style={{
                width:'100%', padding:'9px 12px', background:'#fff', border:'none', borderTop:`1px solid ${M.line2}`,
                display:'flex', alignItems:'center', gap:8, fontSize:12, fontWeight:600, color:M.ochre, cursor:'pointer',
              }}>
                <I name="sliders" size={13} color={M.ochre}/>
                {t('notif.reviewNow')}
                <I name="arrowR" size={12} color={M.ochre} style={{ marginLeft:'auto' }}/>
              </button>
            </div>
          )}
        </div>

        <InviteCards/>

        {coOwnerRequests.length > 0 && (
          <div style={{ marginBottom:14 }}>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Co-ownership requests</div>
            <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
              {coOwnerRequests.map((item, i) => (
                <React.Fragment key={`${item.acct.id}-${item.req.userId}`}>
                  {i > 0 && <Divider inset={0}/>}
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name="card" size={16} color={M.ink3}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:M.ink, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.req.userId} wants co-ownership</div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.acct.name} · {item.spaceName}</div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                      <button className="m-tap" onClick={() => acceptCoOwnerRequest(item)}
                        style={{ padding:'6px 10px', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                        Accept
                      </button>
                      <button className="m-tap" onClick={() => denyCoOwnerRequest(item)}
                        style={{ padding:'6px 10px', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                        Deny
                      </button>
                    </div>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('notif.recentTitle')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {[
            { icon:'check', color:M.sage, title:t('notif.n12synced'), sub:t('notif.n12syncedSub') },
            { icon:'alert', color:M.ochre, title:t('notif.n3review'), sub:t('notif.n3reviewSub') },
            { icon:'wallet', color:M.violet, title:t('notif.salary'), sub:t('notif.salarySub') },
          ].map((n, i, a) => (
            <React.Fragment key={i}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:n.color+'22', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <I name={n.icon} size={15} color={n.color}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:500 }}>{n.title}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{n.sub}</div>
                </div>
              </div>
              {i < a.length - 1 && <Divider inset={44}/>}
            </React.Fragment>
          ))}
        </div>

        {/* Error log — Show Logs button */}
        <LogPanel/>
      </div>
    </div>
  );
}

const DEFAULT_DEV_LOGS = [
  { id:'l1',  level:'error', msg:'localStorage key munni_topics_p_demo parse error: Unexpected token', ts:'Today 09:18',     src:'useLocalStorage:14' },
  { id:'l2',  level:'warn',  msg:'CategoryPicker: unknown catId "custom_xyz" in profile p_demo',        ts:'Today 11:42',     src:'CategoryPicker:87' },
  { id:'l3',  level:'warn',  msg:'TxCtx: transaction t_sync_1747 has no matching account — skipped',   ts:'Yesterday 18:30', src:'TxCtx:52' },
  { id:'l4',  level:'info',  msg:'PeriodCtx: period_day changed 1â†’18, rebuilding period history',       ts:'Yesterday 15:02', src:'PeriodCtx:34' },
  { id:'l5',  level:'info',  msg:'AllocProvider: loaded 3 topics for profile p1',                       ts:'Yesterday 14:55', src:'AllocProvider:21' },
  { id:'l6',  level:'error', msg:'ScreenExpenses: failed to parse munni_budgets_p2 — defaulting to []', ts:'Yesterday 12:11', src:'ScreenExpenses:203' },
  { id:'l7',  level:'warn',  msg:'SyncHandler: duplicate transaction id tsync_1748 skipped',            ts:'Yesterday 10:05', src:'SyncHandler:88' },
  { id:'l8',  level:'info',  msg:'ProfilesProvider: loaded key munni_profiles_google (1 profiles)',     ts:'Yesterday 09:30', src:'ProfilesProvider:12' },
  { id:'l9',  level:'warn',  msg:'ReviewSwipe: previewTx cat "other" has no icon — using fallback',     ts:'2 days ago 16:44', src:'ReviewSwipe:61' },
  { id:'l10', level:'info',  msg:'TxCtx: 142 transactions loaded for account main',                     ts:'2 days ago 08:00', src:'TxCtx:29' },
  { id:'l11', level:'error', msg:'GoalsCtx: munni_goals_p3 corrupt — resetting to defaults',            ts:'3 days ago 20:15', src:'GoalsCtx:17' },
  { id:'l12', level:'info',  msg:'LangCtx: language changed to nl',                                     ts:'3 days ago 11:22', src:'LangCtx:8' },
];

function LogPanel() {
  const { t } = useLang();
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('all');
  const [logs, setLogs] = useLocalStorage('munni_dev_logs', DEFAULT_DEV_LOGS);
  const [readIds, setReadIds] = useLocalStorage('munni_log_read', []);

  const errCount = logs.filter(l => l.level==='error' && !readIds.includes(l.id)).length;
  const warnCount = logs.filter(l => l.level==='warn' && !readIds.includes(l.id)).length;

  const handleOpen = () => {
    setOpen(true);
    setReadIds(logs.map(l => l.id));
  };

  const handleClear = (e) => {
    e.stopPropagation();
    setLogs([]);
    setReadIds([]);
  };

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);
  const levelColor = { error: M.clay, warn: M.ochre, info: M.ink3 };
  const levelBg = { error: M.claySoft, warn: M.ochreSoft, info: M.paper2 };

  return (
    <div style={{ marginBottom:16 }}>
      <button className="m-tap" onClick={handleOpen} style={{
        width:'100%', padding:'12px 16px', borderRadius:14, border:`1px solid ${M.line}`,
        background:M.card, display:'flex', alignItems:'center', gap:10, cursor:'pointer',
        fontFamily:M.fontUI, textAlign:'left',
      }}>
        <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <I name="alert" size={16} color={errCount>0?M.clay:M.ink3}/>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:600, color:M.ink }}>{t('notif.devLogs')}</div>
          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{logs.length} entries</div>
        </div>
        {(errCount > 0 || warnCount > 0) && (
          <div style={{ display:'flex', gap:4 }}>
            {errCount > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.claySoft, color:M.clay }}>{errCount} error{errCount>1?'s':''}</span>}
            {warnCount > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.ochreSoft, color:M.ochre }}>{warnCount} warn</span>}
          </div>
        )}
        <I name="caretR" size={14} color={M.ink4}/>
      </button>

      {open && (
        <Sheet onClose={() => setOpen(false)}>
          <div style={{ padding:'4px 16px 0', display:'flex', alignItems:'center', marginBottom:12 }}>
            <div style={{ fontSize:17, fontWeight:700, flex:1 }}>{t('notif.devLogs')}</div>
            {logs.length > 0 && (
              <button className="m-tap" onClick={handleClear} style={{
                padding:'5px 12px', borderRadius:8, border:`1px solid ${M.clay}44`,
                background:M.claySoft, color:M.clay, fontSize:12, fontWeight:600,
                cursor:'pointer', fontFamily:M.fontUI,
              }}>{t('notif.clearLogs')}</button>
            )}
          </div>
          <div style={{ padding:'0 16px', marginBottom:12 }}>
            <div style={{ display:'flex', gap:6 }}>
              {[['all','All'],['error','Error'],['warn','Warn'],['info','Info']].map(([key,lbl]) => (
                <button key={key} className="m-tap" onClick={() => setFilter(key)} style={{
                  flex:1, padding:'6px 0', borderRadius:8, fontSize:11, fontWeight:600,
                  border:`1px solid ${filter===key?M.sage:M.line}`,
                  background:filter===key?M.sageSoft:'transparent', color:filter===key?M.sage:M.ink3,
                  cursor:'pointer', fontFamily:M.fontUI,
                }}>{lbl}</button>
              ))}
            </div>
          </div>
          <div style={{ padding:'0 16px 16px', maxHeight:320, minHeight:320, overflowY:'auto', display:'flex', flexDirection:'column', gap:8 }}>
            {filtered.length === 0 ? (
              <div style={{ padding:'24px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>{t('notif.noLogs')}</div>
            ) : filtered.map(log => (
              <div key={log.id} style={{ padding:'10px 12px', borderRadius:10, background:levelBg[log.level], border:`1px solid ${levelColor[log.level]}22`, flexShrink:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                  <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:levelColor[log.level], color:'#fff', textTransform:'uppercase' }}>{log.level}</span>
                  <span style={{ fontSize:10, color:M.ink4, flex:1 }}>{log.src}</span>
                  <span style={{ fontSize:10, color:M.ink4 }}>{log.ts}</span>
                </div>
                <div style={{ fontSize:12, color:M.ink2, fontFamily:M.fontMono, lineHeight:1.45, wordBreak:'break-word' }}>{log.msg}</div>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function SettingToggle({ label, sub, on: onProp }) {
  const [on, setOn] = React.useState(!!onProp);
  return (
    <div className="m-tap" onClick={() => setOn(!on)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: M.ink3, marginTop: 2 }}>{sub}</div>}
      </div>
      <Toggle on={on}/>
    </div>
  );
}



export function ScreenCustomizeHome() {
  const nav = useNav();
  const { t } = useLang();
  const [cards, setCards] = useLocalStorage('munni_home_cards', HOME_CARDS_DEFAULT);
  const [upcomingDays, setUpcomingDays] = useLocalStorage('munni_upcoming_days', 3);
  const [customGraphCards, setCustomGraphCards] = useLocalStorage('munni_custom_graphs', []);

  // Separate pinned cards (fixed order) from moveable cards
  const pinnedCards = cards.filter(c => c.pinned);
  const moveableCards = cards.filter(c => !c.pinned);

  const move = (idx, dir) => {
    const ns = [...moveableCards];
    const t = idx + dir;
    if (t < 0 || t >= ns.length) return;
    [ns[idx], ns[t]] = [ns[t], ns[idx]];
    setCards([...pinnedCards, ...ns]);
  };

  const toggle = (id) => {
    setCards(cs => cs.map(c => c.id === id && !c.pinned ? { ...c, visible: !c.visible } : c));
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.customize')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ fontSize:13, color:M.ink3, marginBottom:16, paddingLeft:4, lineHeight:1.5 }}>
          Choose which cards appear on your home screen and in what order. Transaction Review and Overview are always shown at the top.
        </div>

        {/* Pinned cards */}
        <div className="m-card" style={{ border:`1px solid ${M.ochre}22`, background:'#FBF6E9', marginBottom:8 }}>
          {pinnedCards.map((pc, i) => (
            <React.Fragment key={pc.id}>
              {i > 0 && <Divider inset={16}/>}
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px' }}>
                <div style={{ width:28, height:28, borderRadius:8, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="lock" size={13} color={M.ochre}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}>{pc.label}</div>
                    <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', letterSpacing:'0.05em' }}>Pinned</span>
                  </div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{pc.sub}</div>
                </div>
                <div style={{ width:28, height:44, opacity:0.25, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3 }}>
                  <div style={{ width:16, height:1.5, borderRadius:1, background:M.ink4 }}/>
                  <div style={{ width:16, height:1.5, borderRadius:1, background:M.ink4 }}/>
                  <div style={{ width:16, height:1.5, borderRadius:1, background:M.ink4 }}/>
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Moveable cards */}
        <div className="m-card" style={{ border:`1px solid ${M.line}` }}>
          {moveableCards.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 && <Divider inset={16}/>}
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', transition:'all 0.2s ease' }}>
                <button className="m-tap" onClick={() => toggle(s.id)} style={{
                  width:28, height:28, borderRadius:8, flexShrink:0, cursor:'pointer',
                  border:`1.5px solid ${s.visible?M.sage:M.line}`,
                  background:s.visible?M.sage:'transparent',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  {s.visible && <I name="check" size={13} color="#fff" stroke={2.5}/>}
                </button>
                <div style={{ flex:1, opacity:s.visible?1:0.5 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}>{s.label}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{s.sub}</div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                  <button className="m-tap" onClick={() => move(i, -1)} style={{ width:26, height:22, borderRadius:6, border:`1px solid ${M.line}`, background:M.card, display:'flex', alignItems:'center', justifyContent:'center', cursor:i===0?'not-allowed':'pointer', opacity:i===0?0.3:1 }}>
                    <I name="arrowUp" size={11}/>
                  </button>
                  <button className="m-tap" onClick={() => move(i, 1)} style={{ width:26, height:22, borderRadius:6, border:`1px solid ${M.line}`, background:M.card, display:'flex', alignItems:'center', justifyContent:'center', cursor:i===moveableCards.length-1?'not-allowed':'pointer', opacity:i===moveableCards.length-1?0.3:1 }}>
                    <I name="arrowDn" size={11}/>
                  </button>
                </div>
              </div>
              {s.id === 'upcoming' && s.visible && !s.pinned && (
                <div style={{ padding:'10px 16px 14px', borderTop:`1px solid ${M.line2}`, background:M.paper2 }}>
                  <div style={{ fontSize:12, color:M.ink3, marginBottom:8, fontWeight:500 }}>Lookahead window</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    {[3,7,14,30].map(n => (
                      <button key={n} className="m-tap" onClick={() => setUpcomingDays(n)} style={{
                        flex:1, height:36, borderRadius:10, fontSize:13, fontWeight:600,
                        border:`1.5px solid ${upcomingDays===n?M.sage:M.line}`,
                        background:upcomingDays===n?M.sage:'transparent',
                        color:upcomingDays===n?'#fff':M.ink2, cursor:'pointer', fontFamily:M.fontUI,
                      }}>{n}d</button>
                    ))}
                  </div>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
        <div style={{ marginTop:14, padding:14, borderRadius:12, background:M.sageSoft, display:'flex', gap:10 }}>
          <I name="help" size={16} color={M.sage}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5, flex:1 }}>
            Pinned cards are always shown at the top. Use the checkboxes to show or hide other cards, and arrows to reorder them.
          </div>
        </div>
        <div style={{ textAlign:'center', padding:'20px 0 8px' }}>
          <button className="m-tap" onClick={() => setCards(HOME_CARDS_DEFAULT)}
            style={{ background:'none', border:'none', color:M.ink3, fontSize:13, cursor:'pointer', fontFamily:M.fontUI }}>
            Reset to default
          </button>
        </div>

        {/* Custom graph cards */}
        <div className="m-cap" style={{ marginBottom:8, marginTop:16, paddingLeft:4 }}>Custom cards · {customGraphCards.length}</div>
        {customGraphCards.length > 0 && (
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:10, border:`1px solid ${M.line}` }}>
            {customGraphCards.map((cg, i) => (
              <React.Fragment key={cg.id}>
                {i > 0 && <Divider inset={48}/>}
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                  <div style={{ width:32, height:32, borderRadius:9, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name="trending-up" size={14} color={M.sage}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}>{cg.name}</div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>
                      {cg.metric === 'expenses' ? 'Expenses' : 'Income'} · {cg.excludeCategories?.length > 0 ? `${cg.excludeCategories.length} excluded` : 'all categories'}
                    </div>
                  </div>
                  <button className="m-tap" onClick={() => setCustomGraphCards(prev => prev.filter(x => x.id !== cg.id))}
                    style={{ background:'none', border:'none', cursor:'pointer', padding:4 }}>
                    <I name="x" size={14} color={M.ink4}/>
                  </button>
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="m-tap m-card" onClick={() => nav.push('customGraphCreate')}
          style={{ padding:'13px 16px', marginBottom:14, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:12, color:M.sage }}>
          <div style={{ width:32, height:32, borderRadius:9, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name="plus" size={14} color={M.sage}/>
          </div>
          <div style={{ flex:1, fontSize:14, fontWeight:600 }}>Create custom card</div>
          <I name="caretR" size={14} color={M.ink4}/>
        </div>
      </div>
    </div>
  );
}

