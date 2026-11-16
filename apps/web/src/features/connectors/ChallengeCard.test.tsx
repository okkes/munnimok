// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { ChallengeCard } from './ChallengeCard';
import type { ChallengeView } from './types';

const passive = (promptKey?: string): ChallengeView => ({
  id: 'c1',
  type: 'app_approval',
  answerKind: 'text',
  promptKey,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});

function show(challenge: ChallengeView) {
  const onAnswer = vi.fn();
  render(
    <LangProvider>
      <ChallengeCard provider="amazon" sessionId="s1" challenge={challenge} busy={false} onAnswer={onAnswer} />
    </LangProvider>,
  );
  return onAnswer;
}

describe('ChallengeCard: a passive challenge', () => {
  it('an approval in the party’s app says so', () => {
    show(passive());
    expect(screen.getByTestId('connect-waiting').textContent).toMatch(/approval in the party’s app/);
    expect(screen.getByTestId('connect-answer-submit').textContent).toBe('I approved it');
  });

  it('#623: a check in the browser window is not dressed as an approval in an app', () => {
    const onAnswer = show(passive('connect.challenge.captcha_in_browser'));
    expect(screen.getByTestId('connect-challenge-prompt').textContent).toMatch(/window that opened/);
    expect(screen.getByTestId('connect-waiting').textContent).toBe('Waiting for the check in that window…');
    expect(screen.getByTestId('connect-waiting').textContent).not.toMatch(/app/i);
    fireEvent.click(screen.getByText('I solved it'));
    expect(onAnswer).toHaveBeenCalledWith('');
  });
});
