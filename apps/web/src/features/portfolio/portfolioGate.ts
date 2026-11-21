import { useSession } from '@/app/session';

/** #677: the feature is unfinished, so only the demo, with its made-up holdings, opens it; everyone else reads "Coming soon" */
export const usePortfolioOpen = (): boolean => useSession((state) => state.identity?.kind === 'demo');
