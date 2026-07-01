import React from 'react';

export function BankLogoSVG({ bankId, bankName, bankColor, size = 36, radius = 10 }) {
  const s = { width:size, height:size, borderRadius:radius, overflow:'hidden', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' };
  const text = (txt, bg, fg='#fff', fs=13) => (
    <div style={{ ...s, background: bg }}>
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <text x="20" y={fs > 11 ? 26 : 29} textAnchor="middle" fill={fg} fontWeight="900" fontSize={fs} fontFamily="Arial,sans-serif">{txt}</text>
      </svg>
    </div>
  );
  const heart = (bg) => (
    <div style={{ ...s, background: bg }}>
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <path d="M20 30 C20 30 6 21 6 13 C6 8 10 5 14 5 C16.5 5 18.5 6.5 20 8 C21.5 6.5 23.5 5 26 5 C30 5 34 8 34 13 C34 21 20 30 20 30Z" fill="white"/>
      </svg>
    </div>
  );
  const diamond = (bg, fg='#fff') => (
    <div style={{ ...s, background: bg }}>
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <polygon points="20,6 34,20 20,34 6,20" fill={fg}/>
      </svg>
    </div>
  );
  const leaf = (bg) => (
    <div style={{ ...s, background: bg }}>
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <path d="M20 32 C20 32 8 22 8 14 C8 9 13 6 20 8 C27 6 32 9 32 14 C32 22 20 32 20 32Z" fill="white" opacity="0.9"/>
        <line x1="20" y1="32" x2="20" y2="14" stroke="white" strokeWidth="2" opacity="0.6"/>
      </svg>
    </div>
  );
  switch (bankId) {
    case 'ing':         return text('ING', '#FF6200', '#fff', 13);
    case 'abn':         return text('ABN', '#009B77', '#fff', 12);
    case 'rabo':        return text('Rabo', '#004A97', '#fff', 10);
    case 'sns':         return text('SNS', '#E30613', '#fff', 13);
    case 'asn':         return leaf('#00A651');
    case 'triodos':     return text('Trio', '#00A651', '#fff', 10);
    case 'bunq':        return heart('#00D4A1');
    case 'knab':        return text('KNAB', '#E40046', '#fff', 10);
    case 'regio':       return text('Regio', '#0070BA', '#fff', 9);
    case 'revolut':     return diamond('#191C20');
    case 'n26':         return text('N26', '#000', '#fff', 14);
    case 'wise':        return text('W', '#9FE870', '#222', 20);
    case 'deutsche':    return text('DB', '#0018A8', '#fff', 13);
    case 'commerzbank': return text('CB', '#FFCA28', '#333', 12);
    case 'sparkasse':   return text('S', '#E10000', '#fff', 20);
    case 'dkb':         return text('DKB', '#002A6E', '#fff', 12);
    case 'monzo':       return text('M', '#FF3464', '#fff', 20);
    case 'starling':    return text('SB', '#7ACCA0', '#fff', 12);
    case 'lloyds':      return text('L', '#024731', '#fff', 20);
    case 'barclays':    return text('B', '#00AEE9', '#fff', 20);
    case 'hsbc':        return text('HSBC', '#DB0011', '#fff', 10);
    default: {
      const initials = (bankName || '').slice(0, 2).toUpperCase() || '?';
      return <div style={{ ...s, background: bankColor || '#888', color:'#fff', fontSize:13, fontWeight:700, fontFamily:'Arial,sans-serif', display:'flex', alignItems:'center', justifyContent:'center' }}>{initials}</div>;
    }
  }
}
