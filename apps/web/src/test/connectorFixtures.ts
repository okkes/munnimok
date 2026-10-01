import type { ProviderManifest } from '@/features/connectors/types';

/** the mock store as the relay renders it, with the knobs a test turns */
export function manifestOf(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: 'mock-store-simple',
    name: 'Mock Store',
    kind: 'store',
    country: 'NL',
    manifestVersion: 1,
    runtime: 'http',
    agent: { required: false, class: 'inline', desktopBrowser: false },
    unattendedFetch: true,
    loginNeedsHeadedAgent: false,
    logout: 'none',
    offersCredentialStore: false,
    secretCustody: 'client',
    webSupport: 'ephemeral',
    logoRef: 'mock',
    notesKey: 'connect.mock.notes',
    auth: {
      flow: 'password',
      config: [],
      steps: [
        {
          id: 'credentials',
          labelKey: 'connect.step.credentials',
          fields: [
            { key: 'username', type: 'text', secret: false, required: true, labelKey: 'connect.field.email', autofill: 'username' },
            { key: 'password', type: 'password', secret: true, required: true, labelKey: 'connect.field.password', autofill: 'current-password' },
          ],
        },
      ],
      challenges: [],
      session: { ttlSeconds: 2_592_000, refreshable: true, rotatesOnUse: true },
      reauth: { cheap: true, triggerCodes: ['session_expired'] },
    },
    resources: [{ id: 'receipts', returns: 'receipt', typicalDurationSeconds: 1, maxRecordsPerFetch: 200 }],
    limits: { minIntervalSeconds: 60, concurrency: 1, minRequestGapMs: 0, maxHistoryDays: 365, settlementLagDays: 0 },
    status: { providerId: 'mock-store-simple', state: 'healthy', since: '2026-09-29T00:00:00Z' },
    ...overrides,
  };
}

/** the catalogue document around one or more manifests */
export const catalogueOf = (...providers: ProviderManifest[]) => ({
  providers,
  service: { kinds: ['store', 'bank', 'registry'], version: 'test', manifestDigest: 'digest-1' },
});

export const NO_INGEST = { records: 0, receipts: 0, accounts: 0, transactions: 0, positions: 0, dropped: 0 };
