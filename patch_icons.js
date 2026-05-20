// patch_icons.js — replace old I() SVG component usages with IcoMDI for category icons
const fs = require('fs');
let c = fs.readFileSync('munni.html', 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  if (c.indexOf(from) === -1) { console.warn('NOT FOUND:', from.slice(0, 80)); return; }
  c = c.replace(from, to);
  console.log('✓', from.slice(0, 70));
}

// Transaction row cat icon (home screen)
rep(
  `<I name={cat.icon || 'box'} size={18} color={M.ink2} stroke={1.6}/>`,
  `<IcoMDI name={cat.icon || 'help-circle-outline'} size={18} color={M.ink2}/>`
);

// TxDetail hero icon
rep(
  `<I name={primaryCat.icon || 'box'} size={28} color={M.ink2}/>`,
  `<IcoMDI name={primaryCat.icon || 'help-circle-outline'} size={28} color={M.ink2}/>`
);

// TxDetail categories card split icons
rep(
  `<I name={cat.icon||'box'} size={14} color={isUncategorized ? M.ink4 : M.ink2}/>`,
  `<IcoMDI name={cat.icon||'help-circle-outline'} size={14} color={isUncategorized ? M.ink4 : M.ink2}/>`
);

// ScreenExpenses original tx icon
rep(
  `<I name={CATEGORIES[originalTx.cat]?.icon || 'box'} size={16} color={M.clay}/>`,
  `<IcoMDI name={CATEGORIES[originalTx.cat]?.icon || 'help-circle-outline'} size={16} color={M.clay}/>`
);

// CategoryPicker sub icon
rep(
  `<I name={cat.icon||'box'} size={14} color={M.ink2}/>`,
  `<IcoMDI name={cat.icon||'help-circle-outline'} size={14} color={M.ink2}/>`
);

// CategoryPicker parent/all icon
rep(
  `<I name={c.icon || 'box'} size={14} color={M.ink2}/>`,
  `<IcoMDI name={c.icon || 'help-circle-outline'} size={14} color={M.ink2}/>`
);

// ReviewSwipe preview cat icon
rep(
  `<I name={CATEGORIES[previewTx.cat]?.icon || 'box'} size={16} color={M.clay}/>`,
  `<IcoMDI name={CATEGORIES[previewTx.cat]?.icon || 'help-circle-outline'} size={16} color={M.clay}/>`
);

// CategoryPicker group row icon
rep(
  `<I name={cat.icon || 'box'} size={15} color={M.ink2}/>`,
  `<IcoMDI name={cat.icon || 'help-circle-outline'} size={15} color={M.ink2}/>`
);

// CategoryPicker picked/selected icon
rep(
  `<I name={pickedCat.icon || 'box'} size={14} color={M.ink2}/>`,
  `<IcoMDI name={pickedCat.icon || 'help-circle-outline'} size={14} color={M.ink2}/>`
);

// TxDetail picked category display icon
rep(
  `<I name={selCat.icon||'box'} size={16} color={isPositive ? M.clay : M.sage}/>`,
  `<IcoMDI name={selCat.icon||'help-circle-outline'} size={16} color={isPositive ? M.clay : M.sage}/>`
);

// Transaction category icon
rep(
  `<I name={tCat.icon||'box'} size={16} color={txPositive ? M.sage : M.clay}/>`,
  `<IcoMDI name={tCat.icon||'help-circle-outline'} size={16} color={txPositive ? M.sage : M.clay}/>`
);

// Custom graph card category icon
rep(
  `<I name={cat.icon||'box'} size={16} color={cat.color||M.ink2}/>`,
  `<IcoMDI name={cat.icon||'help-circle-outline'} size={16} color={cat.color||M.ink2}/>`
);

// 'other' subcategory icon name: 'box' -> MDI name
rep(
  `name:'Other', icon:'box', color:M.paper2`,
  `name:'Other', icon:'dots-horizontal', color:M.paper2`
);

fs.writeFileSync('munni.html', c.replace(/\n/g, '\r\n'), 'utf8');
console.log('Done');
