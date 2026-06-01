import React from 'react';
import { M, I, StatusBar, AppBar } from '../theme.jsx';
import { useNav } from '../i18n.jsx';


export function ScreenStub({ title }) {
  const nav = useNav();
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={title || 'Screen'} leading={
        <button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>
      }/>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: M.ink3 }}>
        <I name="box" size={32} color={M.ink4}/>
        <div style={{ fontSize: 14 }}>{title} — coming up</div>
      </div>
    </div>
  );
}
