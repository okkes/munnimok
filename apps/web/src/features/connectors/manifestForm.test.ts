import { describe, expect, it } from 'vitest';
import {
  actionKey,
  allFields,
  callbackSchemeOf,
  connectableHere,
  copyKey,
  encodeTaps,
  errorKey,
  formSteps,
  needsOwnComputer,
  progressKey,
  splitValues,
  validateValues,
} from './manifestForm';
import { manifestOf } from '@/test/connectorFixtures';

describe('manifestForm — a manifest becomes a form', () => {
  it('turns the steps into form steps, the non-secret config leading', () => {
    const manifest = manifestOf({
      auth: {
        ...manifestOf().auth,
        config: [{ key: 'country', type: 'select', secret: false, required: true, labelKey: 'connect.lidl.country', options: ['NL', 'DE'] }],
      },
    });
    const steps = formSteps(manifest);
    expect(steps.map((s) => s.id)).toEqual(['config', 'credentials']);
    expect(steps[0].labelKey).toBe('connect.step.settings');
    expect(steps[0].fields[0]).toMatchObject({ key: 'country', type: 'select', options: ['NL', 'DE'], labelKey: 'connect.lidl.country' });
    expect(steps[1].fields.map((f) => f.key)).toEqual(['username', 'password']);
    // a remote-browser login asks nothing: the human signs in on the party's page
    expect(formSteps(manifestOf({ auth: { ...manifestOf().auth, flow: 'remote_browser', steps: [] } }))).toEqual([]);
  });

  it('falls back to munni copy when the manifest names a key munni does not carry', () => {
    const fields = allFields(manifestOf({ auth: { ...manifestOf().auth, steps: [{ id: 'x', fields: [{ key: 'code', type: 'number', secret: false, required: false, labelKey: 'connect.field.from_mars' }] }] } }));
    expect(fields[0].labelKey).toBe('connect.field.number');
    expect(copyKey('connect.field.email', 'connect.field.text')).toBe('connect.field.email');
    expect(errorKey('no_such_code')).toBe('connect.error.internal');
    expect(errorKey('rate_limited')).toBe('connect.error.rate_limited');
    expect(progressKey('downloading')).toBe('connect.progress.downloading');
    expect(actionKey('none')).toBeNull();
    expect(actionKey('start_your_agent')).toBe('connect.action.start_your_agent');
  });

  it('validates required fields and the manifest pattern, tolerating a pattern the browser cannot compile', () => {
    const fields = allFields(
      manifestOf({
        auth: {
          ...manifestOf().auth,
          steps: [
            {
              id: 'credentials',
              fields: [
                { key: 'username', type: 'text', secret: false, required: true, pattern: '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$' },
                { key: 'password', type: 'password', secret: true, required: false },
                { key: 'odd', type: 'text', secret: false, required: false, pattern: '(' },
              ],
            },
          ],
        },
      }),
    );
    expect(validateValues(fields, {})).toEqual({ username: 'required' });
    expect(validateValues(fields, { username: 'not-an-email' })).toEqual({ username: 'pattern' });
    expect(validateValues(fields, { username: 'a@b.nl', odd: 'anything' })).toEqual({});
  });

  it('splits the values into inputs (secrets verbatim) and config (trimmed)', () => {
    const manifest = manifestOf({
      auth: { ...manifestOf().auth, config: [{ key: 'country', type: 'select', secret: false, required: true, options: ['NL'] }] },
    });
    expect(splitValues(manifest, { username: ' a@b.nl ', password: ' p w ', country: ' NL ' })).toEqual({
      inputs: { username: 'a@b.nl', password: ' p w ' },
      config: { country: 'NL' },
    });
  });

  it('knows which parties can be connected from here', () => {
    expect(connectableHere(manifestOf(), 'web')).toBe(true);
    expect(connectableHere(manifestOf({ webSupport: 'none' }), 'web')).toBe(false);
    expect(connectableHere(manifestOf({ webSupport: 'none' }), 'native')).toBe(true);
    expect(connectableHere(manifestOf({ status: { providerId: 'x', state: 'paused', since: '' } }), 'native')).toBe(false);
    expect(connectableHere(manifestOf({ status: { providerId: 'x', state: 'retired', since: '' } }), 'native')).toBe(false);
    expect(needsOwnComputer(manifestOf({ agent: { required: true, class: 'byo', desktopBrowser: true } }))).toBe(true);
    expect(needsOwnComputer(manifestOf({ agent: { required: true, class: 'pooled', desktopBrowser: false } }))).toBe(false);
  });

  it('encodes taps the way the connector reads them, and reads a callback scheme', () => {
    expect(encodeTaps([{ x: 0.33, y: 0.66 }, { x: 1.4, y: -0.2 }])).toBe('tap.v1:0.3300,0.6600;1.0000,0.0000;submit');
    expect(encodeTaps([])).toBe('tap.v1:submit');
    expect(callbackSchemeOf('appie://login-exit*')).toBe('appie');
    expect(callbackSchemeOf('https://example.com/done')).toBe('https');
    expect(callbackSchemeOf(undefined)).toBeNull();
  });
});
