// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

const info = (householdAgents: boolean) => ({ service: { kinds: ['store', 'bank', 'registry'], version: 'test', manifestDigest: 'd' }, providers: 9, householdAgents });
const agent = (extra: Record<string, unknown> = {}) => ({
  id: 'agt_1',
  name: 'the kitchen laptop',
  class: 'byo',
  revoked: false,
  lastHeartbeatAt: new Date(Date.now() - 30_000).toISOString(),
  online: true,
  stale: false,
  profiles: [{ id: 'prof_1', provider: 'asn-persistent', healthy: true, lastOkAt: null }],
  ...extra,
});

describe('Your own computer — the household agents (§10.4)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('lists the agents with their health and logins, enrols a new one with a pasted line, and revokes with the warning', async () => {
    let revoked = false;
    let enrolledName = '';
    renderAppAsUser('/connections/agents', {
      api: {
        'GET /connectors': () => info(true),
        'GET /connectors/agents': () => ({ agents: revoked ? [] : [agent(), agent({ id: 'agt_2', name: 'the old desktop', online: false, stale: true, profiles: [] })] }),
        'POST /connectors/agents/enrollment': (body) => {
          enrolledName = (body as { name: string }).name;
          return {
            code: 'ENR-KITCHEN-1',
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            controlPlaneUrl: 'https://munni.example/connector',
            composeCommand: 'CONNECTOR_URL=https://munni.example/connector ENROLLMENT_CODE=ENR-KITCHEN-1 docker compose -f household-agent.yml up -d',
          };
        },
        'DELETE /connectors/agents/agt_1': () => {
          revoked = true;
          return new Response(null, { status: 204 });
        },
      },
    });
    await screen.findByTestId('screen-agents');
    expect(screen.getByTestId('agents-what')).toBeTruthy();
    const laptop = await screen.findByTestId('agent-agt_1', {}, { timeout: 5000 });
    expect(laptop.textContent).toContain('the kitchen laptop');
    expect(screen.getByTestId('agent-health-agt_1').textContent).toBe('Online');
    expect(screen.getByTestId('agent-profiles-agt_1').textContent).toContain('asn-persistent');
    expect(screen.getByTestId('agent-health-agt_2').textContent).toBe('Needs an update');

    // enrol: a name, then the line to paste — with the code in it
    fireEvent.click(screen.getByTestId('agents-add-open'));
    fireEvent.click(await screen.findByTestId('agents-enrol'));
    await screen.findByTestId('agents-name-blocker');
    fireEvent.change(screen.getByTestId('agents-name'), { target: { value: 'the attic pc' } });
    fireEvent.click(screen.getByTestId('agents-enrol'));
    const compose = await screen.findByTestId('agents-compose', {}, { timeout: 5000 });
    expect(compose.textContent).toContain('ENROLLMENT_CODE=ENR-KITCHEN-1');
    expect(enrolledName).toBe('the attic pc');
    expect(screen.getByTestId('agents-code-note').textContent).toContain('ENR-KITCHEN-1');
    fireEvent.click(screen.getByTestId('agents-enrol-done'));

    // revoke: the shared danger sheet with the profile warning, then the agent is gone
    fireEvent.click(screen.getByTestId('agent-revoke-agt_1'));
    expect((await screen.findByTestId('agent-revoke-body')).textContent).toContain('the kitchen laptop');
    fireEvent.click(screen.getByTestId('agent-revoke-confirm'));
    await waitFor(() => expect(screen.queryByTestId('agent-agt_1')).toBeNull());
    expect(revoked).toBe(true);
  }, 20_000);

  it('a hosted private agent (#420 A2): ask for one, wait for the admin, withdraw, then the slot is listed as hosted and can be given back', async () => {
    let stage: 'free' | 'pending' | 'bound' | 'released' = 'free';
    const slot = agent({ id: 'agt_slot', name: 'munni dev private agent 1', hosted: true, bound: true, profiles: [] });
    const request = (state: string) => ({ id: 'par_1', state, createdAt: new Date().toISOString() });
    const standing = () => {
      if (stage === 'pending') return { offered: true, free: 1, request: request('pending'), agent: null };
      if (stage === 'bound') return { offered: true, free: 0, request: request('approved'), agent: slot };
      if (stage === 'released') return { offered: true, free: 0, request: request('released'), agent: null };
      return { offered: true, free: 1, request: null, agent: null };
    };
    renderAppAsUser('/connections/agents', {
      api: {
        'GET /connectors': () => info(true),
        'GET /connectors/agents': () => ({ agents: stage === 'bound' ? [slot] : [] }),
        'GET /connectors/private-agents/mine': () => standing(),
        'POST /connectors/private-agents/requests': () => {
          stage = 'pending';
          return request('pending');
        },
        // the admin approved meanwhile: the reload after the withdraw finds the slot bound
        'DELETE /connectors/private-agents/requests/par_1': () => {
          stage = 'bound';
          return new Response(null, { status: 204 });
        },
        'DELETE /connectors/private-agents/mine': () => {
          stage = 'released';
          return new Response(null, { status: 204 });
        },
      },
    });
    await screen.findByTestId('screen-agents');
    const card = await screen.findByTestId('agents-private', {}, { timeout: 5000 });
    expect(card.textContent).toContain('1 free right now');
    fireEvent.click(screen.getByTestId('agents-private-request'));
    await screen.findByTestId('agents-private-pending', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('agents-private-withdraw'));
    const held = await screen.findByTestId('agents-private-held', {}, { timeout: 5000 });
    expect(held.textContent).toContain('munni dev private agent 1');
    expect(screen.getByTestId('agent-hosted-agt_slot').textContent).toBe('Hosted by munni');
    expect(screen.getByTestId('agent-revoke-agt_slot').textContent).toBe('Give back');

    // giving it back: the warning says the next person gets it clean, then it is gone from the list
    fireEvent.click(screen.getByTestId('agent-revoke-agt_slot'));
    expect((await screen.findByTestId('agent-revoke-body')).textContent).toContain('clean');
    fireEvent.click(screen.getByTestId('agent-revoke-confirm'));
    await waitFor(() => expect(screen.queryByTestId('agent-agt_slot')).toBeNull());
    await screen.findByTestId('agents-private-request', {}, { timeout: 5000 });
  }, 20_000);

  it('says so where household agents are not offered, and asks the demo to sign in', async () => {
    renderAppAsUser('/connections/agents', {
      api: {
        'GET /connectors': () => info(false),
        'GET /connectors/agents': () => ({ agents: [] }),
      },
    });
    await screen.findByTestId('screen-agents');
    await screen.findByTestId('agents-not-offered', {}, { timeout: 5000 });
    expect(screen.queryByTestId('agents-add-open')).toBeNull();
  }, 15_000);

  it('the hub doors into it', async () => {
    renderApp('/connections');
    await screen.findByTestId('screen-connections');
    // the demo never calls out: no door, the sign-in note instead
    expect(screen.queryByTestId('conn-agents')).toBeNull();
    renderApp('/connections/agents');
    await screen.findByTestId('agents-signin-note');
  }, 15_000);
});
