/**
 * Generates tests/gallery/index.html from screenshots in tests/screenshots/
 * Run: node tests/generate-gallery.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(__dirname, 'screenshots');
const GALLERY_DIR = path.join(__dirname, 'gallery');

// ---------------------------------------------------------------------------
// Metadata: defines title, description, group, and tags for each screenshot
// ---------------------------------------------------------------------------
const META = {
  '01-login-fresh': {
    group: 'Main Login',
    title: 'Fresh install',
    desc: 'First time user. munni_opened_before not set → heading reads "Welcome to munni". All three sign-in methods visible.',
    tags: ['first-run'],
  },
  '02-login-returning': {
    group: 'Main Login',
    title: 'Returning user',
    desc: 'munni_opened_before = "true" → heading changes to "Welcome back". Email field may be pre-filled from sessionStorage.',
    tags: ['returning'],
  },
  '03-login-email-error': {
    group: 'Main Login',
    title: 'Email not found',
    desc: 'User typed an unregistered address and pressed Continue. Red border on input, error text with inline "Create account →" CTA.',
    tags: ['error', 'edge-case'],
  },
  '04-login-sso-loading': {
    group: 'Main Login',
    title: 'Google SSO — loading',
    desc: 'Full-screen loading state shown for 1 400 ms while the app simulates the SSO handshake. Three pulsing dots animate below the provider logo.',
    tags: ['state', 'animation'],
  },
  '05-login-sso-loading-apple': {
    group: 'Main Login',
    title: 'Apple SSO — loading',
    desc: 'Same loading screen for Apple. Provider logo and dot color differ from Google.',
    tags: ['state', 'animation'],
  },
  '06-signup-picker': {
    group: 'Signup — Method Picker',
    title: 'Method picker (empty)',
    desc: 'No prior accounts. All three options available: Google, Apple, and email. User picks how to register.',
    tags: ['first-run'],
  },
  '07-signup-google-disabled': {
    group: 'Signup — Method Picker',
    title: 'Google already registered',
    desc: 'munni_signup_methods includes "google". Google button is grayed out (opacity 0.45) with "Already used" note below. Apple and email still enabled.',
    tags: ['edge-case', 'disabled'],
  },
  '08-signup-both-sso-disabled': {
    group: 'Signup — Method Picker',
    title: 'Both SSO methods disabled',
    desc: 'Both Google and Apple already registered. Email option is the only active path. Notes shown below each disabled button.',
    tags: ['edge-case', 'disabled'],
  },
  '09-signup-email-form': {
    group: 'Signup — Email Entry',
    title: 'Email form (empty)',
    desc: 'User has chosen "Sign up with email". Form shows the email input and "Send verification code" button (disabled until input is non-empty).',
    tags: [],
  },
  '10-signup-email-invalid': {
    group: 'Signup — Email Entry',
    title: 'Invalid format',
    desc: 'Input "bla@bla." fails EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/. Requires a non-empty TLD segment after the last dot.',
    tags: ['validation', 'error'],
  },
  '11-signup-email-reserved': {
    group: 'Signup — Email Entry',
    title: 'Reserved address',
    desc: 'google@munni.app, apple@munni.app, and bank@munni.app are blocked. Error: "This email address cannot be used for sign-up."',
    tags: ['validation', 'error', 'edge-case'],
  },
  '12-signup-email-exists': {
    group: 'Signup — Email Entry',
    title: 'Address already registered',
    desc: 'Email found in munni_signup_emails. Error shown with inline "Sign in instead" CTA that jumps to the email-input login screen with the address pre-filled.',
    tags: ['error', 'edge-case'],
  },
  '13-verify-filling': {
    group: 'Verification',
    title: 'Auto-fill — in progress',
    desc: 'Digits filling one-by-one at 100 ms/digit. "Auto-filling code…" label is visible. Autofill begins 300 ms after a 200 ms initial delay.',
    tags: ['animation', 'state'],
  },
  '14-verify-complete': {
    group: 'Verification',
    title: 'Auto-fill — complete',
    desc: 'All 6 digits filled (signup code: 739251). Still on verify screen; transitions to onboarding 800 ms after the last digit appears.',
    tags: ['state'],
  },
  '15-verify-login': {
    group: 'Verification',
    title: 'Login OTP — complete',
    desc: 'Returning email user verify screen. Different code: 427183. Same timing as signup verify. Transitions to home after 800 ms.',
    tags: ['state'],
  },
  '16-email-input-screen': {
    group: 'Email Input (dedicated)',
    title: 'Dedicated sign-in screen',
    desc: 'Reached only via "Sign in instead" when signup attempt fails because address is already registered. Email is pre-filled.',
    tags: ['navigation', 'edge-case'],
  },
  '17-email-input-error': {
    group: 'Email Input (dedicated)',
    title: 'Not found error',
    desc: 'User typed a different address that has no account. Same error as on the main login screen, with "Create account" CTA.',
    tags: ['error', 'edge-case'],
  },
  '18-no-account-google': {
    group: 'No Account Found',
    title: 'No Google account',
    desc: 'User pressed Google on the login screen but has no account registered with that method. Shows Google logo, explanation, and two CTAs: "Continue with Google" (to create account) and "Use email instead".',
    tags: ['edge-case'],
  },
  '19-no-account-apple': {
    group: 'No Account Found',
    title: 'No Apple account',
    desc: 'Same as Google variant but for Apple. Logo, colour scheme, and button label differ.',
    tags: ['edge-case'],
  },
};

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
// Build HTML
// ---------------------------------------------------------------------------
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });

const available = fs.existsSync(SHOTS_DIR)
  ? fs.readdirSync(SHOTS_DIR).filter(f => f.endsWith('.png')).map(f => f.replace('.png', ''))
  : [];

const groups = {};
for (const [key, meta] of Object.entries(META)) {
  if (!groups[meta.group]) groups[meta.group] = [];
  groups[meta.group].push({ key, ...meta, exists: available.includes(key) });
}

const tagPill = (tag) => {
  const color = TAG_COLORS[tag] || '#64748b';
  return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;background:${color}28;color:${color};font-family:monospace">${tag}</span>`;
};

const card = ({ key, title, desc, tags, exists }) => {
  const src = `../screenshots/${key}.png`;
  const placeholder = `<div style="width:100%;aspect-ratio:393/852;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;font-size:12px;font-family:monospace;border-radius:8px">not yet generated</div>`;
  const img = exists
    ? `<a href="${src}" target="_blank"><img src="${src}" style="width:100%;display:block;border-radius:8px;cursor:zoom-in" loading="lazy"/></a>`
    : placeholder;
  const tagsHtml = (tags || []).map(tagPill).join(' ');
  return `
    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;display:flex;flex-direction:column">
      ${img}
      <div style="padding:12px 14px 14px;flex:1;display:flex;flex-direction:column;gap:6px">
        <div style="font-size:13px;font-weight:700;color:#f1f5f9">${title}</div>
        <div style="font-size:11px;color:#64748b;line-height:1.55;flex:1">${desc}</div>
        ${tagsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${tagsHtml}</div>` : ''}
        <div style="font-size:9px;color:#334155;font-family:monospace;margin-top:4px">${key}.png</div>
      </div>
    </div>`;
};

const groupSection = ([name, cards]) => `
  <section style="margin-bottom:48px">
    <h2 style="font-size:14px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#475569;margin:0 0 16px;font-family:monospace">${name}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
      ${cards.map(card).join('\n')}
    </div>
  </section>`;

const totalShots = Object.keys(META).length;
const generated = available.filter(k => META[k]).length;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>munni — Login Flow Gallery</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #020817; color: #f1f5f9; font-family: -apple-system, system-ui, sans-serif; padding: 32px 24px 64px; }
    h1 { font-size: 22px; font-weight: 800; margin: 0 0 6px; }
    .meta { font-size: 13px; color: #475569; margin-bottom: 40px; }
    .badge { display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace;background:#1e293b;color:#94a3b8;margin-left:8px; }
    @media(max-width:600px){ body { padding: 16px 12px 48px; } }
  </style>
</head>
<body>
  <h1>munni <span class="badge">Login flow</span></h1>
  <div class="meta">
    ${generated}/${totalShots} screenshots generated &nbsp;·&nbsp;
    Run <code style="background:#1e293b;padding:1px 6px;border-radius:4px;font-size:12px">npm run gallery</code> to refresh
    &nbsp;·&nbsp; Generated ${new Date().toLocaleString()}
  </div>
  ${Object.entries(groups).map(groupSection).join('\n')}
</body>
</html>`;

fs.writeFileSync(path.join(GALLERY_DIR, 'index.html'), html, 'utf8');
console.log(`Gallery written → tests/gallery/index.html  (${generated}/${totalShots} screenshots available)`);
