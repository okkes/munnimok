import React from 'react';
import { M, I, StatusBar } from '../../app/theme.jsx';
import { useNav, TabBar } from '../../app/nav.jsx';
import { useLang } from '../../shared/i18n.jsx';


export function ScreenPortfolio() {
  const nav = useNav();
  const { t } = useLang();
  return (
    <div className="m-screen">
      <StatusBar/>
      <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'0 32px 48px', gap:16 }}>
        <div style={{ width:72, height:72, borderRadius:20, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <I name="wallet" size={32} color={M.sage}/>
        </div>
        <div style={{ fontSize:22, fontWeight:700, color:M.ink, textAlign:'center' }}>{t('tab.portfolio')}</div>
        <div style={{ fontSize:15, color:M.ink3, textAlign:'center', lineHeight:1.5 }}>{t('portfolio.comingSoon')}</div>
      </div>
      <TabBar active="portfolio" onChange={(t) => nav.switchTab(t)}/>
    </div>
  );
}
