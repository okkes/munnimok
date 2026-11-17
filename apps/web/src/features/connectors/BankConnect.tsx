import { useState } from 'react';
import { BankPickerSheet } from './BankPickerSheet';
import { ConnectSteps } from './ConnectSteps';
import type { FlowRequest } from './ConnectSteps';
import { useCatalogue } from './useCatalogue';

// #527: connect a bank from a space's accounts without a detour; the connection is the person's (All accounts manages it),
// its accounts attach to this space
export function BankConnect({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const catalogue = useCatalogue();
  const [flow, setFlow] = useState<FlowRequest | null>(null);
  return (
    <>
      <BankPickerSheet
        open={open}
        onOpenChange={onOpenChange}
        providers={catalogue.providers}
        loading={catalogue.loading}
        error={catalogue.error}
        onRetry={catalogue.reload}
        onPick={(manifest) => {
          onOpenChange(false);
          setFlow({ manifest, reconnectId: null });
        }}
      />
      <ConnectSteps flow={flow} onFlowChange={setFlow} catalogue={catalogue} />
    </>
  );
}
