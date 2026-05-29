// patch_mdi_svg.js
// Replaces MDI font approach with inline SVG paths from @mdi/js
// Run: node patch_mdi_svg.js
const https = require('https');
const fs = require('fs');

// All MDI icon names used in CATEGORIES
const NEEDED = [
  'cash-plus','cash-refund','cash-remove','help-circle-outline',
  'office-building-outline','home-city-outline','store-clock-outline',
  'chart-timeline-variant','piggy-bank-outline','bank-remove','bank-plus',
  'home-outline','home-import-outline','home-lightning-bolt-outline',
  'wrench-outline','warehouse','bus-side','car-outline','gas-station-outline',
  'train-car','food-outline','cart-variant','bread-slice-outline',
  'room-service-outline','food-takeout-box-outline','candy-outline',
  'smoking','coffee-outline','mirror','content-cut','toothbrush',
  'hair-dryer-outline','drama-masks','popcorn','curtains','soccer-field',
  'slot-machine-outline','checkerboard','gamepad-square-outline',
  'heart-multiple-outline','television-play','tennis','dumbbell','biathlon',
  'shopping-outline','tshirt-crew-outline','cellphone-link','sofa-single-outline',
  'gift-outline','account-heart-outline','party-popper','watering-can-outline',
  'robot-outline','baby-face-outline','island','airplane-takeoff','bed-outline',
  'car-key','map-marker-outline','school-outline','account-cash-outline',
  'human-male-board','book-education-outline','notebook-edit-outline',
  'certificate-outline','newspaper-variant-outline','hospital-box-outline',
  'stethoscope','pill','tooth-outline','eye-outline','brain','needle','ambulance',
  'briefcase-outline','handshake-outline','tools','nail','account-tie-outline',
  'currency-eur','bank-outline','shield-outline','dots-horizontal',
  // used in NewCatForm icon picker
  'star-outline','flag-outline','tag-outline','bell-outline','lock-outline',
  'bolt-outline','fire','leaf-outline','music-note-outline','paw-outline',
  'car-side','bike','walk','run','swim','weight-lifter','yoga',
];

// Convert kebab-case to camelCase mdi export name: cash-plus → mdiCashPlus
function toExportName(name) {
  return 'mdi' + name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching @mdi/js paths...');
  const jsContent = await fetchUrl('https://cdn.jsdelivr.net/npm/@mdi/js@7.4.47/mdi.es.js');
  console.log('Downloaded', jsContent.length, 'bytes');

  const paths = {};
  for (const iconName of NEEDED) {
    const exportName = toExportName(iconName);
    // Match: export var mdiCashPlus = "M...";
    const re = new RegExp(`var ${exportName}\\s*=\\s*"([^"]+)"`, 'g');
    const m = re.exec(jsContent);
    if (m) {
      paths[iconName] = m[1];
    } else {
      console.warn('NOT FOUND:', iconName, '(', exportName, ')');
    }
  }

  console.log(`Found ${Object.keys(paths).length}/${NEEDED.length} icon paths`);

  // Generate the MDI_PATHS object
  const pathsStr = JSON.stringify(paths, null, 2);

  // Now patch munni.html
  let c = fs.readFileSync('munni.html', 'utf8').replace(/\r\n/g, '\n');

  // 1. Remove MDI font CDN link
  c = c.replace(
    `  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css" crossorigin="anonymous"/>\n`,
    ''
  );

  // 2. Replace IcoMDI to use SVG paths
  c = c.replace(
    `function IcoMDI({ name, size = 20, color }) {
  return <i className={'mdi mdi-' + name} style={{ fontSize: size, color: color || 'currentColor', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: size, height: size }}/>;
}`,
    `const MDI_PATHS = ${pathsStr};
function IcoMDI({ name, size = 20, color }) {
  const d = MDI_PATHS[name] || MDI_PATHS['help-circle-outline'] || '';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink:0, display:'block' }}>
      <path d={d} fill={color || 'currentColor'}/>
    </svg>
  );
}`
  );

  fs.writeFileSync('munni.html', c.replace(/\n/g, '\r\n'), 'utf8');
  console.log('Done — munni.html patched');
}

main().catch(console.error);
