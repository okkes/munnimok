import React from 'react';

// ---------------------------------------------------------------------------
// Activation: append ?dev=1 to the URL. Persists for the browser session.
// ---------------------------------------------------------------------------
const isDevActive = () => {
  if (new URLSearchParams(window.location.search).get('dev') === '1') {
    sessionStorage.setItem('munni_dev_mode', '1');
  }
  return sessionStorage.getItem('munni_dev_mode') === '1';
};

const DevCtx = React.createContext(false);
export const useDevMode = () => React.useContext(DevCtx);

export function DevModeProvider({ children }) {
  const active = React.useMemo(isDevActive, []);
  return <DevCtx.Provider value={active}>{children}</DevCtx.Provider>;
}

// ---------------------------------------------------------------------------
// Annotation data — one entry per screenKey (= login mode string)
// ---------------------------------------------------------------------------
const C = {
  state:   '#3b82f6',
  flow:    '#10b981',
  rule:    '#f59e0b',
  edge:    '#ef4444',
  storage: '#a78bfa',
};

const ANNOTATIONS = {
  'login': {
    screen: 'Login',
    sub: 'Main entry point — first screen after install or logout',
    states: [
      { tag: 'fresh install',    note: 'munni_opened_before not set → heading "Welcome to munni"' },
      { tag: 'returning user',   note: 'munni_opened_before = "true" → heading "Welcome back"' },
      { tag: 'SSO loading',      note: 'loadingMethod set → 1 400 ms simulated delay; button shows spinner' },
      { tag: 'email not found',  note: 'loginError set → red border on input; inline "Create account" CTA' },
    ],
    flows: [
      { from: 'Google',             to: 'Home',                    cond: 'google ∈ munni_signup_methods' },
      { from: 'Google',             to: 'Signup onboarding',       cond: 'google ∉ munni_signup_methods' },
      { from: 'Apple',              to: 'Home',                    cond: 'apple ∈ munni_signup_methods' },
      { from: 'Apple',              to: 'Signup onboarding',       cond: 'apple ∉ munni_signup_methods' },
      { from: 'Email → Continue',   to: 'Email verify → Home',     cond: 'email ∈ munni_signup_emails' },
      { from: 'Email → Continue',   to: 'Error + "Create account"',cond: 'email not registered' },
      { from: '"Create account"',   to: 'mode = signup' },
      { from: '"Use demo"',         to: 'Home (demo data)',        cond: 'always; resets demo profiles' },
    ],
    rules: [
      'Email input: no format check — only checks if address is registered',
      'Email override: entering the NEW address after an email-change resolves to the old canonical key',
      'Verify code (login): always 427183 — hardcoded for prototype',
      'SSO delay: always 1 400 ms regardless of network',
      'hasOpenedBefore: LS key "munni_opened_before" === "true" controls heading copy',
    ],
    edge: [
      'Changed email: old address → "not found"; new address silently resolves to old canonical email for storage key lookup',
      'Google/Apple already registered → login goes directly to Home, no onboarding',
      '"Not found" error: pressing "Create account" pre-fills the typed email in signup',
      'Email field pre-filled from sessionStorage if previous session used email login',
    ],
    storage: [
      'munni_signup_methods (LS) — string[] of registered method IDs',
      'munni_signup_emails (LS) — string[] of registered email addresses',
      'munni_opened_before (LS) — controls welcome heading copy',
      'munni_profile_email (SS) — pre-fills email input on return',
      'munni_email_override (LS) — {from, to} for changed-email resolution',
    ],
  },

  'signup': {
    screen: 'Signup — method picker',
    sub: 'User picks how to register. SSO buttons disabled if already used.',
    states: [
      { tag: 'SSO disabled',  note: 'opacity 0.45 + "Already used" note below button if method already registered' },
      { tag: 'signup error',  note: 'signupError shown in red box at top (e.g. "Google already registered")' },
    ],
    flows: [
      { from: 'Google',        to: 'Signup onboarding',  cond: 'google ∉ munni_signup_methods' },
      { from: 'Google',        to: 'Error: already used', cond: 'google ∈ munni_signup_methods' },
      { from: 'Apple',         to: 'Signup onboarding',  cond: 'apple ∉ munni_signup_methods' },
      { from: 'Apple',         to: 'Error: already used', cond: 'apple ∈ munni_signup_methods' },
      { from: 'Email option',  to: 'mode = signup-email' },
      { from: 'Back',          to: 'mode = login' },
    ],
    rules: [
      'Google/Apple: cursor not-allowed, pointer events blocked when disabled',
      'All three methods (google + apple + email) can coexist on one device',
      'SSO: simulated 1 400 ms delay before checking munni_signup_methods',
    ],
    edge: [
      '"Already used" note appears below the button — not a modal or toast',
      'Error box at top only appears when signupError state is set (SSO-level error)',
    ],
    storage: [
      'munni_signup_methods (LS) — checked to disable already-registered SSO buttons',
    ],
  },

  'signup-email': {
    screen: 'Signup — email entry',
    sub: 'User types an email address to register with. Three distinct error cases.',
    states: [
      { tag: 'invalid format',   note: 'EMAIL_RE fails → "Please enter a valid email address"' },
      { tag: 'reserved email',   note: 'google@/apple@/bank@munni.app → "This email is reserved"' },
      { tag: 'already exists',   note: '"Already registered" + inline "Sign in instead" CTA' },
    ],
    flows: [
      { from: 'Send code',         to: 'mode = signup-email-verify', cond: 'valid + not reserved + not registered' },
      { from: '"Sign in instead"', to: 'mode = email-input (email pre-filled)' },
      { from: 'Back',              to: 'mode = signup' },
    ],
    rules: [
      'Regex: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/ — requires TLD; rejects "bla@bla."',
      'Reserved: google@munni.app, apple@munni.app, bank@munni.app',
      'Input trimmed + lowercased before all checks',
      'Button disabled (opacity 0.5) when input is empty',
    ],
    edge: [
      '"Sign in instead" only appears with the "already registered" error, not the others',
      'Lowercasing means "User@Email.COM" and "user@email.com" are the same account',
    ],
    storage: [
      'munni_signup_emails (LS) — checked for duplicate detection',
    ],
  },

  'signup-email-verify': {
    screen: 'Signup — verify code',
    sub: 'Simulated OTP. Auto-fills after 300 ms, then transitions to onboarding.',
    states: [
      { tag: 'auto-filling', note: 'Digits fill one-by-one at 100 ms/digit; transitions after 800 ms pause' },
    ],
    flows: [
      { from: 'Auto-fill complete', to: 'mode = signup-onboarding' },
      { from: 'Back',               to: 'mode = signup-email' },
    ],
    rules: [
      'Correct prototype code: 739251',
      'Auto-fill: starts 300 ms after render, 100 ms per digit, 800 ms hold before transition',
    ],
    edge: [
      'Native: send OTP via email; verify server-side; do NOT auto-fill',
      'Native: add retry limit + cooldown (e.g. 3 attempts, then 60 s lock)',
    ],
    storage: [],
  },

  'email-input': {
    screen: 'Login — email entry',
    sub: 'Standalone email-input step for returning email users.',
    states: [
      { tag: 'not found',  note: 'loginError set → red border; inline "Create account" CTA' },
    ],
    flows: [
      { from: 'Continue',          to: 'mode = email-verify', cond: 'email found in munni_signup_emails' },
      { from: 'Continue',          to: 'Error inline',        cond: 'email not found' },
      { from: '"Create account"',  to: 'mode = signup-email (email pre-filled)' },
      { from: 'Back',              to: 'mode = login' },
    ],
    rules: [
      'Same logic as the email input on the login screen — no format check, only lookup',
      'Email override active: entering NEW address resolves to old canonical key',
    ],
    edge: [
      '"Create account" inline CTA copies current input into signupEmailInput before switching mode',
    ],
    storage: [
      'munni_signup_emails (LS)',
      'munni_email_override (LS) — {from, to} checked before lookup',
    ],
  },

  'email-verify': {
    screen: 'Login — verify code',
    sub: 'OTP step for returning email users. Same animation as signup verify.',
    states: [
      { tag: 'auto-filling', note: 'Same timing as signup verify; different code' },
    ],
    flows: [
      { from: 'Auto-fill complete', to: 'Home (logged in)' },
      { from: 'Back',               to: 'mode = login' },
    ],
    rules: [
      'Correct prototype code: 427183 (different from signup code 739251)',
      'Same timing: 300 ms start, 100 ms/digit, 800 ms hold',
    ],
    edge: [
      'Native: each login attempt triggers a new OTP; invalidate previous codes server-side',
      'Native: rate-limit — max 5 requests per 10 min per email',
    ],
    storage: [],
  },

  'language': {
    screen: 'Language picker',
    sub: 'Accessible from login screen and Settings. Selecting a supported language takes effect immediately.',
    states: [
      { tag: 'search active',   note: 'Typing in the search box filters the "Other languages" list by name or BIC code' },
      { tag: 'lang selected',   note: 'Current language shows green checkmark; tapping another supported lang switches immediately' },
    ],
    flows: [
      { from: 'Supported lang row', to: 'Language switches; screen closes', cond: 'EN / NL / TR only' },
      { from: 'Coming-soon row',    to: 'No action — row is non-interactive' },
      { from: 'Back',               to: 'Previous screen (login or Settings)' },
    ],
    rules: [
      'Available languages: EN, NL, TR — each renders with flag image (Twemoji SVG)',
      'Selection persisted in LS key "munni_lang" (JSON string)',
      'Flag images get CSS counter-invert in dark mode to undo the root invert filter',
      'Search matches language name AND native name (case-insensitive)',
    ],
    edge: [
      'Switching language from this screen re-renders entire app immediately via LangProvider context',
      '"Coming soon" rows must never be tappable — no handler attached',
    ],
    storage: [
      'munni_lang (LS) — persists selected language code ("en" | "nl" | "tr")',
    ],
  },

  'terms': {
    screen: 'Terms of Service',
    sub: 'Static legal content. Same component as Privacy Policy (showPrivacy=false).',
    states: [],
    flows: [
      { from: 'Back', to: 'Login screen' },
    ],
    rules: [
      'Content is translated: EN / NL / TR sections all present in CONTENT map',
      '7 sections: Acceptance, Service description, Read-only access, User responsibilities, Data accuracy, Limitation of liability, Changes to terms',
      'Shared component with Privacy Policy — switched via showPrivacy prop',
    ],
    edge: [
      'Native: replace static content with server-fetched legal markdown; version-stamp shown to user',
    ],
    storage: [],
  },

  'privacy': {
    screen: 'Privacy Policy',
    sub: 'Static legal content. Same component as Terms of Service (showPrivacy=true).',
    states: [],
    flows: [
      { from: 'Back', to: 'Login screen' },
    ],
    rules: [
      'Content is translated: EN / NL / TR',
      '6 sections: Data we collect, How we use your data, Data storage, Your rights, Cookies, Contact',
      'Shared component with Terms of Service — switched via showPrivacy prop',
    ],
    edge: [
      'Native: GDPR requires a versioned privacy policy with explicit user acceptance; current prototype does not track consent version',
    ],
    storage: [],
  },

  'no-account': {
    screen: 'No account found',
    sub: 'Shown when user taps Google/Apple on login screen but has no account with that method.',
    states: [],
    flows: [
      { from: '"Create account"', to: 'mode = signup' },
      { from: 'Back',             to: 'mode = login' },
    ],
    rules: [
      'noAccountMethod state holds "google" or "apple" — used to show which method failed',
    ],
    edge: [
      'User may have registered with email but not with Google/Apple — guide them back to email login',
    ],
    storage: [],
  },
};

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------
const Tag = ({ color, children }) => (
  <span style={{
    display: 'inline-block', padding: '1px 5px', borderRadius: 3,
    background: color + '28', color, fontSize: 9.5, fontWeight: 700,
    letterSpacing: 0.4, textTransform: 'uppercase', fontFamily: 'monospace',
  }}>{children}</span>
);

const SectionHead = ({ label, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 5, margin: '10px 0 5px' }}>
    <div style={{ width: 3, height: 11, borderRadius: 2, background: color, flexShrink: 0 }}/>
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.9, color, textTransform: 'uppercase', fontFamily: 'monospace' }}>{label}</span>
  </div>
);

const Row = ({ children }) => (
  <div style={{
    fontSize: 10.5, color: '#cbd5e1', lineHeight: 1.55,
    padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
  }}>{children}</div>
);

export function DevPanel({ screenKey }) {
  const active = useDevMode();
  const [open, setOpen] = React.useState(false);

  if (!active) return null;

  const ann = ANNOTATIONS[screenKey];

  return (
    <div style={{ position: 'absolute', bottom: 16, right: 8, zIndex: 9000, pointerEvents: 'none' }}>

      {/* Expanded panel */}
      {open && (
        <div style={{
          pointerEvents: 'auto',
          position: 'absolute', bottom: 30, right: 0,
          width: 272, maxHeight: 480,
          background: '#0c111d', borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '9px 11px 7px', borderBottom: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#f1f5f9', fontFamily: 'monospace' }}>
                {ann ? ann.screen : screenKey}
              </span>
              <Tag color="#64748b">{screenKey}</Tag>
            </div>
            {ann?.sub && (
              <div style={{ fontSize: 9.5, color: '#475569', lineHeight: 1.4, marginTop: 3 }}>{ann.sub}</div>
            )}
          </div>

          {/* Scrollable body */}
          <div style={{ overflowY: 'auto', padding: '2px 11px 12px' }}>
            {!ann ? (
              <div style={{ fontSize: 11, color: '#475569', padding: '12px 0' }}>
                No annotation for <code style={{ color: '#94a3b8' }}>{screenKey}</code>
              </div>
            ) : (
              <>
                {ann.states?.length > 0 && (
                  <>
                    <SectionHead label="States" color={C.state}/>
                    {ann.states.map((s, i) => (
                      <Row key={i}>
                        <Tag color={C.state}>{s.tag}</Tag>
                        <span style={{ color: '#94a3b8', marginLeft: 5 }}>{s.note}</span>
                      </Row>
                    ))}
                  </>
                )}

                {ann.flows?.length > 0 && (
                  <>
                    <SectionHead label="Flows" color={C.flow}/>
                    {ann.flows.map((f, i) => (
                      <Row key={i}>
                        <span style={{ color: '#f1f5f9' }}>{f.from}</span>
                        <span style={{ color: '#334155', margin: '0 3px' }}>→</span>
                        <span style={{ color: '#6ee7b7' }}>{f.to}</span>
                        {f.cond && <div style={{ fontSize: 9.5, color: '#334155', marginTop: 1 }}>if {f.cond}</div>}
                      </Row>
                    ))}
                  </>
                )}

                {ann.rules?.length > 0 && (
                  <>
                    <SectionHead label="Rules" color={C.rule}/>
                    {ann.rules.map((r, i) => (
                      <Row key={i}>
                        <span style={{ color: '#fbbf24', marginRight: 4 }}>•</span>
                        <span style={{ color: '#cbd5e1' }}>{r}</span>
                      </Row>
                    ))}
                  </>
                )}

                {ann.edge?.length > 0 && (
                  <>
                    <SectionHead label="Edge cases" color={C.edge}/>
                    {ann.edge.map((e, i) => (
                      <Row key={i}>
                        <span style={{ color: '#f87171', marginRight: 4 }}>!</span>
                        <span style={{ color: '#cbd5e1' }}>{e}</span>
                      </Row>
                    ))}
                  </>
                )}

                {ann.storage?.length > 0 && (
                  <>
                    <SectionHead label="Storage" color={C.storage}/>
                    {ann.storage.map((s, i) => (
                      <Row key={i}>
                        <span style={{ color: '#c4b5fd', fontFamily: 'monospace', fontSize: 10 }}>{s}</span>
                      </Row>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Toggle pill — always visible when dev mode is on */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          pointerEvents: 'auto',
          background: open ? '#1e293b' : '#2563eb',
          color: '#fff', border: `1px solid ${open ? 'rgba(255,255,255,0.15)' : 'transparent'}`,
          borderRadius: 20, padding: '4px 9px',
          fontSize: 9.5, fontWeight: 800, cursor: 'pointer',
          letterSpacing: 0.6, fontFamily: 'monospace',
          boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: open ? '#64748b' : '#4ade80',
          display: 'inline-block',
          boxShadow: open ? 'none' : '0 0 4px #4ade80',
        }}/>
        DEV
      </button>
    </div>
  );
}
