import { SelectAllRow } from '@/ui/SelectAllRow';
import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { applyMerge, applyReconcile } from '@/application/reconcile';
import type { ReconcileResult } from '@/application/reconcile';
import type { ReconcilePlan } from '@/domain/reconcile';
import type { TransactionRow } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

function TxLine({ tx, lang }: Readonly<{ tx: TransactionRow; lang: ReturnType<typeof useLang>['lang'] }>) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{cleanBankText(tx.merchant)}</span>
        <span className="block text-[11px] text-ink-4">{tx.date}</span>
      </span>
      <span className="m-num shrink-0 text-[13px] font-semibold text-ink">
        {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
      </span>
    </span>
  );
}

// the bank connection is the truth inside its coverage: the full list of mismatched rows shows before anything
// is deleted, each match can be opted out, and pre-coverage history stays untouched
export function ReconcileSheet({
  open,
  onOpenChange,
  accountIds,
  merge,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountIds: string[];
  /** #311: the pair to MERGE: the imported account dissolves into the bank one; absent = in-place reconcile */
  merge?: { importedAccountId: string; bankAccountId: string };
}>) {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const [plan, setPlan] = useState<ReconcilePlan | null>(null);
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  // #311: the (usually long) match list starts folded so the mismatch section is in reach
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // #311: nothing auto-matches: the sheet first asks whether the two sources are the same account
  const [step, setStep] = useState<'ask' | 'review'>('ask');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setIgnored(new Set());
    setMatchesOpen(false);
    setFailed(false);
    setStep('ask');
    setProgress(null);
    void (async () => {
      // one plan across every involved account: the same-IBAN pair feeds both accounts' rows in
      const rows: TransactionRow[] = [];
      for (const accountId of accountIds) {
        rows.push(...((await store.allRows('transaction')).filter((r) => r.deleted === 0 && r.accountId === accountId)));
      }
      const { reconcilePlan } = await import('@/domain/reconcile');
      setPlan(reconcilePlan(rows));
    })();
  }, [open, accountIds, store]);

  const toggleIgnore = (id: string) => {
    setIgnored((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setFailed(false);
    setProgress(null);
    try {
      const tick = (done: number, total: number) => setProgress({ done, total });
      setResult(
        merge
          ? await applyMerge(store, repo, spaceId, merge, plan, ignored, tick)
          : await applyReconcile(store, repo, spaceId, plan, ignored, tick),
      );
    } catch {
      // dying silently read as "nothing happens" (#311)
      setFailed(true);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const judged = plan ? plan.matches.length + plan.mismatched.length : 0;
  // #311: a merge with nothing overlapping is still real work: the imported history moves onto the bank account
  const workable = judged > 0 || (!!merge && (plan?.kept.length ?? 0) > 0);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reconcile.title')}
      size="tall"
      // the desktop dialog uses the width: pairs read side by side
      wide
      // clicking away mid-apply says what is running instead of closing over it
      busyNote={busy ? t('reconcile.busy') : null}
    >
      {result && (
        <div className="flex flex-col items-center gap-3 pt-4 text-center" data-testid="reconcile-done">
          <Icon name="check-circle-outline" size={40} color="var(--m-accent)" />
          <p className="text-[14px] text-ink-2">
            {t(merge ? 'reconcile.mergeDone' : 'reconcile.done', { migrated: result.migrated, removed: result.removed })}
          </p>
          <Button variant="outline" data-testid="reconcile-close" onClick={() => onOpenChange(false)}>
            {t('action.done')}
          </Button>
        </div>
      )}
      {!result && plan && !workable && (
        <p className="pt-2 text-[13px] text-ink-2" data-testid="reconcile-nothing">
          {t('reconcile.nothing')}
        </p>
      )}
      {/* #311: the question comes first, the match list only after a yes */}
      {!result && plan && workable && step === 'ask' && (
        <div className="flex flex-col gap-3 pt-2" data-testid="reconcile-ask">
          <div className="flex items-start gap-3">
            <Icon name="source-merge" size={22} color="var(--m-accent)" />
            <p className="text-[13px] leading-relaxed text-ink-2">
              {t(merge ? 'reconcile.mergeAskBody' : 'reconcile.askBody', { n: judged })}
            </p>
          </div>
          <Button data-testid="reconcile-ask-go" onClick={() => setStep('review')}>
            {t(merge ? 'reconcile.mergeAskGo' : 'reconcile.askGo')}
          </Button>
          <Button variant="outline" data-testid="reconcile-ask-later" onClick={() => onOpenChange(false)}>
            {t('reconcile.askLater')}
          </Button>
        </div>
      )}
      {!result && plan && workable && step === 'review' && (
        <div className="flex flex-col gap-3 pt-1" data-testid="reconcile-review">
          {plan.coverage && (
            <p className="text-[12px] leading-relaxed text-ink-3">
              {t('reconcile.intro', { from: plan.coverage.from, to: plan.coverage.to })}
            </p>
          )}

          {plan.matches.length > 0 && (
            <div>
              <button
                data-testid="reconcile-matches-toggle"
                onClick={() => setMatchesOpen((v) => !v)}
                className="m-tap flex w-full items-center gap-2 border-none bg-transparent px-1 py-1 text-left"
              >
                <span className="m-cap flex-1">{t('reconcile.matches', { n: plan.matches.length })}</span>
                <Icon name={matchesOpen ? 'chevron-up' : 'chevron-down'} size={16} color="var(--m-ink-4)" />
              </button>
              {matchesOpen && (
                <>
                  <p className="mb-1 px-1 text-[11px] text-ink-4">{t('reconcile.matchSub')}</p>
                  <SelectAllRow
                    total={plan.matches.length}
                    selected={plan.matches.filter((match) => !ignored.has(match.imported.id)).length}
                    onChange={(next) => setIgnored(next ? new Set() : new Set(plan.matches.map((match) => match.imported.id)))}
                    testId="reconcile-migrate-all"
                    className="mb-1"
                  />
                  <div className="overflow-hidden rounded-card border border-line bg-surface">
                    {plan.matches.map((match) => (
                      <label // NOSONAR(S6853) its text (both halves of the pair) sits deeper than the rule looks
                        key={match.imported.id}
                        data-testid={`reconcile-match-${match.imported.id}`}
                        className="flex cursor-pointer items-start gap-3 border-b border-line-2 px-4 py-2.5 last:border-0"
                      >
                        <input
                          type="checkbox"
                          data-testid={`reconcile-migrate-${match.imported.id}`}
                          checked={!ignored.has(match.imported.id)}
                          onChange={() => toggleIgnore(match.imported.id)}
                          className="mt-1 h-4 w-4 accent-(--m-accent)"
                        />
                        <span className="grid min-w-0 flex-1 gap-x-4 gap-y-1.5 lg:grid-cols-2">
                          <span className="min-w-0">
                            <span className="m-cap block text-[10px] text-ink-4">{t('reconcile.sideImported')}</span>
                            <TxLine tx={match.imported} lang={lang} />
                          </span>
                          <span className="min-w-0">
                            <span className="m-cap block text-[10px] text-accent-deep">{t('reconcile.sideLinked')}</span>
                            <TxLine tx={match.linked} lang={lang} />
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {plan.mismatched.length > 0 && (
            <div>
              <div className="m-cap mb-1 px-1">{t('reconcile.mismatched', { n: plan.mismatched.length })}</div>
              <p className="mb-1 px-1 text-[11px] text-ink-4">{t('reconcile.mismatchSub')}</p>
              <div className="overflow-hidden rounded-card border border-warning bg-warning-soft/40">
                {plan.mismatched.map((tx) => (
                  <div key={tx.id} data-testid={`reconcile-mismatch-${tx.id}`} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
                    <Icon name="alert-circle-outline" size={16} color="var(--m-warning)" />
                    <TxLine tx={tx} lang={lang} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {plan.kept.length > 0 && (
            <p className="px-1 text-[11px] text-ink-4" data-testid="reconcile-kept">
              {t(merge ? 'reconcile.mergeKept' : 'reconcile.kept', { n: plan.kept.length })}
            </p>
          )}

          {failed && (
            <p className="rounded-card bg-negative-soft px-3 py-2 text-[12px] text-ink" data-testid="reconcile-failed">
              {t('reconcile.failed')}
            </p>
          )}
          {busy && progress && (
            <p className="m-num text-center text-[12px] text-ink-3" data-testid="reconcile-progress">
              {progress.done} / {progress.total}
            </p>
          )}
          <Button variant="danger" data-testid="reconcile-confirm" disabled={busy} onClick={() => void confirm()}>
            {merge ? t('reconcile.mergeConfirm') : t('reconcile.confirm', { n: judged })}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
