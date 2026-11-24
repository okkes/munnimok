import { Sheet } from '@/ui/Sheet';
import { UnlockPad } from './UnlockPad';

/** #302: hosts open it only when a lock config exists; with none configured the action is simply not protected */
export function PinChallengeSheet({
  open,
  onOpenChange,
  title,
  body,
  onPass,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  onPass: () => void;
}>) {
  const pass = () => {
    onOpenChange(false);
    onPass();
  };

  return (
    // tall: the lock screen's four rows of keys under a three-line body would scroll inside a form-sized phone sheet
    <Sheet open={open} onOpenChange={onOpenChange} title={title} size="tall">
      <div className="flex flex-col gap-3 pt-1" data-testid="pin-challenge-sheet">
        <p className="text-[13px] leading-relaxed text-ink-2">{body}</p>
        {/* #530: the same unlock as opening the app: the biometric comes up by itself, the PIN pad stays beside it */}
        <UnlockPad active={open} onPass={pass} reason={title} autoPrompt={() => true} />
      </div>
    </Sheet>
  );
}
