import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENTS, HAPPY, HOSTED_AGENT, PRIVATE, renderLab, scriptFetch } from '../../test/harness';
import { capabilityLines, holderLine } from './AgentScreen';
import { agentHealth, slotHolder } from './AgentsScreen';

describe('Agents', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists the fleet and the own machines with health, heartbeat and kept logins; revoke asks first', async () => {
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal('confirm', confirm);
    let revoked = false;
    const calls = scriptFetch({
      ...HAPPY(),
      'GET /lab/agents': () => ({ body: revoked ? { agents: [AGENTS.agents[0]] } : AGENTS }),
      'DELETE /lab/agents/agt_kitchen': () => {
        revoked = true;
        return { status: 204 };
      },
    });
    renderLab('#/agents');
    const tiles = await screen.findByTestId('agents-tiles');
    expect(tiles.textContent).toContain('1 / 2');
    expect(screen.getByTestId('agent-health-agt_fleet1').textContent).toBe('online');
    expect(screen.getByTestId('agent-health-agt_kitchen').textContent).toBe('offline');
    expect(screen.getByTestId('agent-agt_kitchen').textContent).toContain('asn-persistent');
    expect(screen.getByTestId('agent-agt_fleet1').textContent).toContain('just now');
    fireEvent.click(screen.getByTestId('agent-revoke-agt_kitchen'));
    expect(confirm.mock.calls[0][0]).toContain('1 kept login(s) are destroyed');
    await waitFor(() => expect(calls).toContain('DELETE /lab/agents/agt_kitchen'));
    await waitFor(() => expect(screen.queryByTestId('agent-agt_kitchen')).toBeNull());
  });

  it('private slots: approve binds, take back asks and wipes; the section hides when the relay has no such route', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const calls = scriptFetch({
      ...HAPPY(),
      'POST /lab/private-agents/requests/par_1/approve': () => ({ body: { ...PRIVATE.requests[0], state: 'approved', agentId: 'agt_slot1' } }),
      'POST /lab/private-agents/agt_slot2/release': () => ({ status: 204 }),
    });
    renderLab('#/agents');
    expect((await screen.findByTestId('agents-private-free')).textContent).toBe('1 of 2 free');
    expect(screen.getByTestId('private-slot-agt_slot2').textContent).toContain('Bob');
    fireEvent.click(screen.getByTestId('private-approve-par_1'));
    await waitFor(() => expect(calls).toContain('POST /lab/private-agents/requests/par_1/approve'));
    fireEvent.click(screen.getByTestId('private-release-agt_slot2'));
    await waitFor(() => expect(calls).toContain('POST /lab/private-agents/agt_slot2/release'));
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/private-agents': () => ({ status: 404 }) });
    renderLab('#/agents');
    await screen.findByTestId('agents-table');
    expect(screen.queryByTestId('agents-private')).toBeNull();
  });

  it('enrolling a browser for the lab mints a code and shows the compose line with a copy button', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    const calls = scriptFetch({
      ...HAPPY(),
      'POST /lab/agents/enrollment': (init) => ({
        body: { code: 'AGNT-1234-5678', expiresAt: '2026-10-06T12:15:00Z', controlPlaneUrl: 'https://cp.example', composeCommand: `CONNECTOR_URL=https://cp.example ENROLLMENT_CODE=AGNT-1234-5678 AGENT_NAME='${(JSON.parse(String(init?.body)) as { name: string }).name}' docker compose -f household-agent.yml up -d` },
      }),
    });
    renderLab('#/agents');
    await screen.findByTestId('agents-enrol');
    expect((screen.getByTestId('agents-enrol-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('agents-enrol-name'), { target: { value: 'lab box' } });
    fireEvent.click(screen.getByTestId('agents-enrol-submit'));
    const enrollment = await screen.findByTestId('agents-enrollment');
    expect(enrollment.textContent).toContain("AGENT_NAME='lab box'");
    expect(enrollment.textContent).toContain('code AGNT-1234-5678');
    expect(calls).toContain('POST /lab/agents/enrollment');
    fireEvent.click(screen.getByTestId('agents-enrol-copy'));
    await waitFor(() => expect(screen.getByTestId('agents-enrol-copy').textContent).toBe('copied'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('ENROLLMENT_CODE=AGNT-1234-5678'));
  });

  it('a refused enrollment reaches the error strip; an environment without connectors says so', async () => {
    scriptFetch({ ...HAPPY(), 'POST /lab/agents/enrollment': () => ({ status: 503, body: { error: { code: 'provider_unavailable' } } }) });
    renderLab('#/agents');
    await screen.findByTestId('agents-enrol');
    fireEvent.change(screen.getByTestId('agents-enrol-name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('agents-enrol-submit'));
    expect((await screen.findByTestId('lab-error')).textContent).toContain('provider_unavailable');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/agents': () => ({ status: 404 }) });
    renderLab('#/agents');
    expect(await screen.findByTestId('lab-absent')).toBeTruthy();
  });

  it('an agent opens in full: its claims, the logins it keeps, the runs it took, the retention runs on it, the doors', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const calls = scriptFetch({
      ...HAPPY(),
      'GET /lab/agents': () => ({ body: { agents: [...AGENTS.agents, HOSTED_AGENT] } }),
      'DELETE /lab/agents/agt_kitchen': () => ({ status: 204 }),
      'POST /lab/private-agents/agt_hosted/release': () => ({ status: 204 }),
    });
    renderLab('#/agents');
    fireEvent.click(await screen.findByTestId('agent-open-agt_kitchen'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/agents/agt_kitchen'));
    expect((await screen.findByTestId('agent-title')).textContent).toBe('the kitchen laptop');
    expect(screen.getByTestId('agent-health').textContent).toBe('offline');
    expect(screen.getByTestId('agent-facts').textContent).toContain('none recorded');
    expect(screen.getByTestId('agent-profiles').textContent).toContain('asn-persistent');
    expect(screen.getByTestId('agent-jobs').textContent).toContain('provider_changed');
    expect(screen.getByTestId('agent-retention').textContent).toContain('4 passed, 1 skipped');
    expect(calls).toContain('GET /lab/jobs');
    fireEvent.click(screen.getByTestId('agent-revoke'));
    await waitFor(() => expect(calls).toContain('DELETE /lab/agents/agt_kitchen'));
    fireEvent.click(screen.getByTestId('agent-bench'));
    expect(globalThis.location.hash).toBe('#/bench/retention?agent=agt_kitchen');
    cleanup();

    renderLab('#/agents/agt_hosted');
    expect((await screen.findByTestId('agent-title')).textContent).toBe(HOSTED_AGENT.name);
    expect(screen.getByTestId('agent-facts').textContent).toContain('residential · NL');
    expect(screen.getByTestId('agent-facts').textContent).toContain('browser_persistent, browser_interactive');
    expect(screen.getByTestId('agent-facts').textContent).toContain('hosted slot');
    expect(screen.queryByTestId('agent-revoke')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-release'));
    await waitFor(() => expect(calls).toContain('POST /lab/private-agents/agt_hosted/release'));
    cleanup();

    scriptFetch(HAPPY());
    renderLab('#/agents/agt_nobody');
    expect((await screen.findByTestId('agent-missing')).textContent).toContain('No agent named');
  });

  it('the health and holder helpers', () => {
    const base = AGENTS.agents[0];
    expect(holderLine({ ...base, hosted: true, bound: false, resetting: true }, null)).toBe('wiping…');
    expect(holderLine({ ...base, hosted: true, bound: false, resetting: false }, null)).toBe('free');
    expect(holderLine({ ...base, hosted: true, bound: true, boundAt: '2026-09-30T05:00:00Z' }, 'Bob')).toContain('Bob since');
    expect(capabilityLines(base)[0].value).toBe('none recorded');
    expect(capabilityLines(HOSTED_AGENT).map((l) => l.value)).toEqual(['every party this connector has', 'browser_persistent, browser_interactive', 'residential · NL', '1']);
    expect(agentHealth({ ...base, revoked: true }).label).toBe('revoked');
    expect(agentHealth({ ...base, stale: true }).label).toBe('stale catalogue');
    expect(agentHealth({ ...base, online: false }).label).toBe('offline');
    expect(slotHolder({ agent: { ...base, resetting: true }, subject: null }).label).toBe('wiping…');
    expect(slotHolder({ agent: { ...base, bound: true }, subject: 'u_x', who: null }).label).toBe('u_x');
    expect(slotHolder({ agent: base, subject: null }).label).toBe('free');
  });
});
