/**
 * Generates tests/gallery/index.html from screenshots + videos.
 * Auto-discovers feature metadata from tests/meta/*.meta.mjs.
 * Run: node tests/generate-gallery.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR  = path.join(__dirname, 'screenshots');
const VIDEOS_DIR = path.join(__dirname, 'videos');
const GALLERY_DIR = path.join(__dirname, 'gallery');
const META_DIR   = path.join(__dirname, 'meta');

const VARIANTS = [
  { id: 'en-light-mobile',  lang: 'en', dark: false, viewport: 'mobile',  vpLabel: '393×852' },
  { id: 'en-light-desktop', lang: 'en', dark: false, viewport: 'desktop', vpLabel: '1280×900' },
  { id: 'tr-dark-mobile',   lang: 'tr', dark: true,  viewport: 'mobile',  vpLabel: '393×852' },
  { id: 'tr-dark-desktop',  lang: 'tr', dark: true,  viewport: 'desktop', vpLabel: '1280×900' },
];

const TAG_COLORS = {
  'first-run':  '#3b82f6',
  returning:    '#8b5cf6',
  error:        '#ef4444',
  validation:   '#f59e0b',
  'edge-case':  '#ec4899',
  state:        '#06b6d4',
  animation:    '#10b981',
  disabled:     '#64748b',
  navigation:   '#a78bfa',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const available = (dir, ext) => fs.existsSync(dir)
  ? new Set(fs.readdirSync(dir).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length)))
  : new Set();

const shots   = available(SHOTS_DIR,  '.png');
const videos  = available(VIDEOS_DIR, '.webm');

const tagPill = (tag) => {
  const color = TAG_COLORS[tag] || '#64748b';
  return `<span class="tag" style="background:${color}28;color:${color}">${tag}</span>`;
};

// ---------------------------------------------------------------------------
// Card renderers
// ---------------------------------------------------------------------------

function variantBadge(V) {
  const langColor  = V.lang === 'en' ? '#3b82f6' : '#f97316';
  const themeIcon  = V.dark ? '🌙' : '☀️';
  const vpIcon     = V.viewport === 'mobile' ? '📱' : '🖥';
  return `<span class="vbadge" style="background:${langColor}28;color:${langColor}">${V.lang.toUpperCase()}</span>`
       + `<span class="vbadge">${themeIcon}</span>`
       + `<span class="vbadge">${vpIcon} ${V.vpLabel}</span>`;
}

function stepPlayer(key, V, stepLabels) {
  // Build the steps array: --s1, --s2, ..., final (no suffix)
  const steps = [];
  for (let i = 1; i < stepLabels.length; i++) {
    const name = `${key}--${V.id}--s${i}`;
    if (shots.has(name)) {
      steps.push({ img: `../screenshots/${name}.png`, label: stepLabels[i - 1] });
    }
  }
  // Always add final screenshot as last step
  const finalName = `${key}--${V.id}`;
  steps.push({ img: `../screenshots/${finalName}.png`, label: stepLabels[stepLabels.length - 1] });

  if (steps.length < 2) return null; // not enough steps to show a player

  const stepsJson = JSON.stringify(steps).replace(/'/g, "\\'");
  return `
    <div class="step-player" data-steps='${stepsJson}'>
      <div class="sp-img-wrap">
        <img class="sp-img" src="${steps[0].img}" loading="lazy" style="width:100%;display:block;border-radius:8px 8px 0 0"/>
        <div class="sp-overlay">
          <button class="sp-nav sp-prev" aria-label="Previous">‹</button>
          <span class="sp-counter">1 / ${steps.length}</span>
          <button class="sp-nav sp-next" aria-label="Next">›</button>
        </div>
      </div>
      <div class="sp-dots">${steps.map((_, i) => `<button class="sp-dot${i === 0 ? ' active' : ''}" data-i="${i}"></button>`).join('')}</div>
      <div class="sp-label">${steps[0].label}</div>
    </div>`;
}

function card(key, meta, V, feature) {
  const name   = `${key}--${V.id}`;
  const exists = shots.has(name);
  const hasVideo = videos.has(name);
  const theme  = V.dark ? 'dark' : 'light';

  const imgBlock = exists
    ? `<a href="../screenshots/${name}.png" target="_blank" class="img-link">
         <img src="../screenshots/${name}.png" style="width:100%;display:block;border-radius:8px 8px 0 0" loading="lazy"/>
       </a>`
    : `<div class="placeholder">not yet generated</div>`;

  const player = meta.steps ? stepPlayer(key, V, meta.steps) : null;
  const mediaBlock = player || imgBlock;

  const videoBlock = hasVideo
    ? `<details class="vid-details">
         <summary>▶ Watch recording</summary>
         <video src="../videos/${name}.webm" controls preload="none" style="width:100%;border-radius:0 0 4px 4px;display:block"></video>
       </details>`
    : '';

  const tagsHtml = (meta.tags || []).map(tagPill).join('');

  return `
    <div class="card"
         data-lang="${V.lang}"
         data-theme="${theme}"
         data-viewport="${V.viewport}"
         data-feature="${feature}">
      ${mediaBlock}
      ${videoBlock}
      <div class="card-body">
        <div class="card-title">${meta.title}</div>
        <div class="card-desc">${meta.desc}</div>
        <div class="card-badges">${variantBadge(V)}</div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
        <div class="card-file">${name}.png</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Discover + render
// ---------------------------------------------------------------------------
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });

const metaFiles = fs.existsSync(META_DIR)
  ? fs.readdirSync(META_DIR).filter(f => f.endsWith('.meta.mjs')).sort()
  : [];

let totalCards = 0;
let generatedCards = 0;
const featureSections = [];
const featureFilterBtns = [];

for (const file of metaFiles) {
  const { FEATURE, FEATURE_LABEL, GROUPS } = await import(pathToFileURL(path.join(META_DIR, file)).href);

  const groupSections = GROUPS.map(group => {
    const cards = [];
    for (const testMeta of group.tests) {
      for (const V of VARIANTS) {
        const name = `${testMeta.key}--${V.id}`;
        totalCards++;
        if (shots.has(name)) generatedCards++;
        cards.push(card(testMeta.key, testMeta, V, FEATURE));
      }
    }
    return `
      <section class="group-section" data-group="${group.name}">
        <h3 class="group-heading">${group.name}</h3>
        <div class="cards-grid">${cards.join('\n')}</div>
      </section>`;
  });

  featureSections.push(`
    <section class="feature-section" data-feature="${FEATURE}">
      <h2 class="feature-heading">${FEATURE_LABEL}</h2>
      ${groupSections.join('\n')}
    </section>`);

  featureFilterBtns.push(`<button class="filter-btn" data-filter="feature" data-value="${FEATURE}">${FEATURE_LABEL}</button>`);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>munni — Screenshot Gallery</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #020817; color: #f1f5f9; font-family: -apple-system, system-ui, sans-serif; padding: 32px 24px 80px; }

    /* Header */
    .site-title { font-size: 24px; font-weight: 800; margin-bottom: 4px; }
    .site-meta { font-size: 12px; color: #475569; margin-bottom: 28px; }
    code { background: #1e293b; padding: 1px 6px; border-radius: 4px; font-size: 11px; }

    /* Filter bar */
    .filter-bar { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; padding: 16px 20px; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; }
    .filter-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .filter-label { font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: .5px; margin-right: 2px; }
    .filter-btn { padding: 4px 11px; border-radius: 20px; border: 1.5px solid #1e293b; background: transparent; color: #64748b; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.15s; }
    .filter-btn:hover { border-color: #334155; color: #94a3b8; }
    .filter-btn.active { background: #1e293b; border-color: #334155; color: #f1f5f9; }

    /* Count badge */
    .count-bar { font-size: 12px; color: #475569; margin-bottom: 32px; }
    .count-num { font-weight: 700; color: #94a3b8; }

    /* Feature + group headings */
    .feature-section { margin-bottom: 56px; }
    .feature-heading { font-size: 18px; font-weight: 800; color: #f1f5f9; margin-bottom: 24px; padding-bottom: 10px; border-bottom: 1px solid #1e293b; }
    .group-section { margin-bottom: 40px; }
    .group-heading { font-size: 11px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase; color: #475569; font-family: monospace; margin-bottom: 14px; }

    /* Grid */
    .cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }

    /* Card */
    .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .card.hidden { display: none; }
    .img-link img { transition: opacity .15s; }
    .img-link:hover img { opacity: .88; }
    .placeholder { aspect-ratio: 393 / 852; background: #1e293b; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 11px; font-family: monospace; border-radius: 8px 8px 0 0; }

    /* Video embed */
    .vid-details { border-top: 1px solid #1e293b; }
    .vid-details summary { padding: 7px 12px; font-size: 11px; color: #475569; cursor: pointer; user-select: none; }
    .vid-details summary:hover { color: #94a3b8; }

    /* Card body */
    .card-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 5px; flex: 1; }
    .card-title { font-size: 13px; font-weight: 700; color: #f1f5f9; }
    .card-desc { font-size: 11px; color: #64748b; line-height: 1.55; flex: 1; }
    .card-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
    .vbadge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; font-family: monospace; }
    .card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; font-family: monospace; }
    .card-file { font-size: 9px; color: #334155; font-family: monospace; margin-top: 2px; }

    /* Step player */
    .step-player { position: relative; }
    .sp-img-wrap { position: relative; }
    .sp-img { width: 100%; display: block; border-radius: 8px 8px 0 0; transition: opacity .18s ease; }
    .sp-img.fading { opacity: 0; }
    .sp-overlay { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,.6); border-radius: 20px; padding: 4px 12px; backdrop-filter: blur(4px); }
    .sp-nav { background: none; border: none; color: #f1f5f9; font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1; opacity: .8; }
    .sp-nav:hover { opacity: 1; }
    .sp-counter { font-size: 11px; color: #94a3b8; font-family: monospace; white-space: nowrap; }
    .sp-dots { display: flex; gap: 5px; justify-content: center; padding: 8px 0 4px; }
    .sp-dot { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid #334155; background: transparent; cursor: pointer; padding: 0; }
    .sp-dot.active { background: #4ade80; border-color: #4ade80; }
    .sp-label { text-align: center; font-size: 11px; color: #64748b; padding: 0 12px 8px; font-style: italic; }

    @media (max-width: 600px) { body { padding: 16px 12px 48px; } .filter-bar { padding: 12px; } }
  </style>
</head>
<body>
  <h1 class="site-title">munni <span style="font-size:14px;font-weight:500;color:#475569">screenshot gallery</span></h1>
  <div class="site-meta">
    <span class="count-num" id="gen-count">${generatedCards}</span>/<span class="count-num">${totalCards}</span> screenshots generated
    &nbsp;·&nbsp; Run <code>npm run gallery</code> to refresh
    &nbsp;·&nbsp; ${new Date().toLocaleString()}
  </div>

  <div class="filter-bar" id="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Lang</span>
      <button class="filter-btn active" data-filter="lang" data-value="en">EN</button>
      <button class="filter-btn" data-filter="lang" data-value="tr">TR</button>
      <button class="filter-btn" data-filter="lang" data-value="all">All</button>
    </div>
    <div class="filter-group">
      <span class="filter-label">Theme</span>
      <button class="filter-btn active" data-filter="theme" data-value="light">☀️ Light</button>
      <button class="filter-btn" data-filter="theme" data-value="dark">🌙 Dark</button>
      <button class="filter-btn" data-filter="theme" data-value="all">All</button>
    </div>
    <div class="filter-group">
      <span class="filter-label">Viewport</span>
      <button class="filter-btn active" data-filter="viewport" data-value="mobile">📱 Mobile</button>
      <button class="filter-btn" data-filter="viewport" data-value="desktop">🖥 Desktop</button>
      <button class="filter-btn" data-filter="viewport" data-value="all">All</button>
    </div>
    <div class="filter-group">
      <span class="filter-label">Feature</span>
      <button class="filter-btn active" data-filter="feature" data-value="all">All</button>
      ${featureFilterBtns.join('')}
    </div>
  </div>

  <div class="count-bar">Showing <span id="visible-count" class="count-num">0</span> cards</div>

  ${featureSections.join('\n')}

  <script>
    // ---------------------------------------------------------------------------
    // Filter logic
    // ---------------------------------------------------------------------------
    const state = { lang: 'en', theme: 'light', viewport: 'mobile', feature: 'all' };

    function applyFilters() {
      const cards = document.querySelectorAll('.card');
      let visible = 0;
      cards.forEach(c => {
        const show =
          (state.lang     === 'all' || c.dataset.lang     === state.lang)     &&
          (state.theme    === 'all' || c.dataset.theme    === state.theme)    &&
          (state.viewport === 'all' || c.dataset.viewport === state.viewport) &&
          (state.feature  === 'all' || c.dataset.feature  === state.feature);
        c.classList.toggle('hidden', !show);
        if (show) visible++;
      });
      document.getElementById('visible-count').textContent = visible;

      // Hide group/feature sections that have no visible cards
      document.querySelectorAll('.group-section').forEach(s => {
        const hasVisible = [...s.querySelectorAll('.card')].some(c => !c.classList.contains('hidden'));
        s.style.display = hasVisible ? '' : 'none';
      });
      document.querySelectorAll('.feature-section').forEach(s => {
        const hasVisible = [...s.querySelectorAll('.card')].some(c => !c.classList.contains('hidden'));
        s.style.display = hasVisible ? '' : 'none';
      });
    }

    document.getElementById('filter-bar').addEventListener('click', e => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;
      const { filter, value } = btn.dataset;
      // Deactivate siblings, activate clicked
      btn.closest('.filter-group').querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state[filter] = value;
      applyFilters();
    });

    applyFilters(); // run on load with default state

    // ---------------------------------------------------------------------------
    // Step player
    // ---------------------------------------------------------------------------
    document.querySelectorAll('.step-player').forEach(player => {
      const steps = JSON.parse(player.dataset.steps);
      const img     = player.querySelector('.sp-img');
      const counter = player.querySelector('.sp-counter');
      const label   = player.querySelector('.sp-label');
      const dots    = player.querySelectorAll('.sp-dot');
      let current = 0;
      let autoTimer = null;

      function show(i, instant) {
        current = ((i % steps.length) + steps.length) % steps.length;
        if (instant) {
          img.src = steps[current].img;
        } else {
          img.classList.add('fading');
          setTimeout(() => {
            img.src = steps[current].img;
            img.classList.remove('fading');
          }, 180);
        }
        counter.textContent = (current + 1) + ' / ' + steps.length;
        label.textContent = steps[current].label;
        dots.forEach((d, i) => d.classList.toggle('active', i === current));
      }

      player.querySelector('.sp-prev').addEventListener('click', () => { clearInterval(autoTimer); show(current - 1); });
      player.querySelector('.sp-next').addEventListener('click', () => { clearInterval(autoTimer); show(current + 1); });
      dots.forEach(d => d.addEventListener('click', () => { clearInterval(autoTimer); show(+d.dataset.i); }));

      function startAuto() { autoTimer = setInterval(() => show(current + 1), 1800); }
      player.addEventListener('mouseenter', () => clearInterval(autoTimer));
      player.addEventListener('mouseleave', startAuto);
      startAuto();
      show(0, true);
    });
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(GALLERY_DIR, 'index.html'), html, 'utf8');
console.log(`Gallery → tests/gallery/index.html  (${generatedCards}/${totalCards} screenshots)`);
