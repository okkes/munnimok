import { useCallback } from 'react';
import {
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { MasterDetailLayout } from '@/ui/SplitPane';
import { AppLayout } from './AppLayout';
import { readSessionIdentity } from './session';
import { rememberAfterLogin } from './afterLogin';
import { ScreenPending, lazyScreen, withScreens } from './lazyScreen';
import type { LazyScreen } from './lazyScreen';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { OnboardingScreen } from '@/features/auth/OnboardingScreen';
import { HomeScreen } from '@/features/home/HomeScreen';
import { UpdateGate } from '@/app/UpdateGate';

// #554: the first paint carries the shell, sign-in, onboarding and Home; every
// other screen is a chunk of its own, fetched on its first visit (the service
// worker precaches every chunk, so an offline start opens any screen)
const InviteScreen = lazyScreen(() => import('@/features/auth/InviteScreen'), 'InviteScreen');
const HomeCustomizeScreen = lazyScreen(() => import('@/features/home/HomeCustomizeScreen'), 'HomeCustomizeScreen');
const TxDetailCustomizeScreen = lazyScreen(() => import('@/features/transactions/TxDetailCustomizeScreen'), 'TxDetailCustomizeScreen');
const TransactionsScreen = lazyScreen(() => import('@/features/transactions/TransactionsScreen'), 'TransactionsScreen');
const TxDetailScreen = lazyScreen(() => import('@/features/transactions/TxDetailScreen'), 'TxDetailScreen');
const TxCreateScreen = lazyScreen(() => import('@/features/transactions/TxFormSheet'), 'TxCreateScreen');
const ReimburseLinkScreen = lazyScreen(() => import('@/features/transactions/ReimburseLinkScreen'), 'ReimburseLinkScreen');
const SpacesScreen = lazyScreen(() => import('@/features/spaces/SpacesScreen'), 'SpacesScreen');
const SpaceSettingsScreen = lazyScreen(() => import('@/features/spaces/SpaceSettingsScreen'), 'SpaceSettingsScreen');
const PeriodSettingsScreen = lazyScreen(() => import('@/features/spaces/PeriodSettingsScreen'), 'PeriodSettingsScreen');
const NavigationSettingsScreen = lazyScreen(() => import('@/features/navigation/NavigationSettingsScreen'), 'NavigationSettingsScreen');
const SpaceAccountsScreen = lazyScreen(() => import('@/features/spaces/SpaceAccountsScreen'), 'SpaceAccountsScreen');
const SpaceMembersScreen = lazyScreen(() => import('@/features/spaces/SpaceMembersScreen'), 'SpaceMembersScreen');
const SettingsScreen = lazyScreen(() => import('@/features/settings/SettingsScreen'), 'SettingsScreen');
const GlobalSettingsScreen = lazyScreen(() => import('@/features/settings/GlobalSettingsScreen'), 'GlobalSettingsScreen');
const GoOfflineScreen = lazyScreen(() => import('@/features/auth/GoOfflineScreen'), 'GoOfflineScreen');
const ReviewScreen = lazyScreen(() => import('@/features/review/ReviewScreen'), 'ReviewScreen');
const AccountsScreen = lazyScreen(() => import('@/features/accounts/AccountsScreen'), 'AccountsScreen');
const ManageCategoriesScreen = lazyScreen(() => import('@/features/categories/ManageCategoriesScreen'), 'ManageCategoriesScreen');
const FriendsScreen = lazyScreen(() => import('@/features/friends/FriendsScreen'), 'FriendsScreen');
const SplitsScreen = lazyScreen(() => import('@/features/splits/SplitsScreen'), 'SplitsScreen');
const SplitDetailScreen = lazyScreen(() => import('@/features/splits/SplitsScreen'), 'SplitDetailScreen');
const SplitJoinScreen = lazyScreen(() => import('@/features/splits/SplitJoinScreen'), 'SplitJoinScreen');
const OverviewScreen = lazyScreen(() => import('@/features/overview/OverviewScreen'), 'OverviewScreen');
const CategoryDrillScreen = lazyScreen(() => import('@/features/overview/CategoryDrillScreen'), 'CategoryDrillScreen');
const BudgetsScreen = lazyScreen(() => import('@/features/budgets/BudgetsScreen'), 'BudgetsScreen');
const BudgetFormScreen = lazyScreen(() => import('@/features/budgets/BudgetFormScreen'), 'BudgetFormScreen');
const BudgetDetailScreen = lazyScreen(() => import('@/features/budgets/BudgetDetailScreen'), 'BudgetDetailScreen');
const EventsScreen = lazyScreen(() => import('@/features/events/EventsScreen'), 'EventsScreen');
const EventDetailScreen = lazyScreen(() => import('@/features/events/EventDetailScreen'), 'EventDetailScreen');
const EventAttachScreen = lazyScreen(() => import('@/features/events/EventAttachScreen'), 'EventAttachScreen');
const EventAddScreen = lazyScreen(() => import('@/features/events/EventAttachScreen'), 'EventAddScreen');
const GoalsScreen = lazyScreen(() => import('@/features/goals/GoalsScreen'), 'GoalsScreen');
const GoalDetailScreen = lazyScreen(() => import('@/features/goals/GoalDetailScreen'), 'GoalDetailScreen');
const GoalCashOutScreen = lazyScreen(() => import('@/features/goals/GoalCashOutScreen'), 'GoalCashOutScreen');
const DebtsScreen = lazyScreen(() => import('@/features/debts/DebtsScreen'), 'DebtsScreen');
const DebtDetailScreen = lazyScreen(() => import('@/features/debts/DebtDetailScreen'), 'DebtDetailScreen');
const DebtPlanScreen = lazyScreen(() => import('@/features/debts/DebtPlanScreen'), 'DebtPlanScreen');
const PlanningScreen = lazyScreen(() => import('@/features/planning/PlanningScreen'), 'PlanningScreen');
const HelpIndexScreen = lazyScreen(() => import('@/features/help/HelpIndexScreen'), 'HelpIndexScreen');
const ConnectionsScreen = lazyScreen(() => import('@/features/connectors/ConnectionsScreen'), 'ConnectionsScreen');
const AgentsScreen = lazyScreen(() => import('@/features/connectors/AgentsScreen'), 'AgentsScreen');
const ReceiptsScreen = lazyScreen(() => import('@/features/shopping/ReceiptsScreen'), 'ReceiptsScreen');
const ReceiptScreen = lazyScreen(() => import('@/features/shopping/ReceiptScreen'), 'ReceiptScreen');
const ConnectionReceiptsScreen = lazyScreen(() => import('@/features/connectors/ConnectionReceiptsScreen'), 'ConnectionReceiptsScreen');
const PortfolioScreen = lazyScreen(() => import('@/features/portfolio/PortfolioScreen'), 'PortfolioScreen');
const HoldingDetailScreen = lazyScreen(() => import('@/features/portfolio/HoldingDetailScreen'), 'HoldingDetailScreen');
const InsightsScreen = lazyScreen(() => import('@/features/insights/InsightsScreen'), 'InsightsScreen');
const TrendsScreen = lazyScreen(() => import('@/features/trends/TrendsScreen'), 'TrendsScreen');
const ProfileScreen = lazyScreen(() => import('@/features/profile/ProfileScreen'), 'ProfileScreen');
const DevicesScreen = lazyScreen(() => import('@/features/profile/DevicesScreen'), 'DevicesScreen');
const UpcomingScreen = lazyScreen(() => import('@/features/home/UpcomingScreen'), 'UpcomingScreen');
const PeriodsScreen = lazyScreen(() => import('@/features/overview/PeriodsScreen'), 'PeriodsScreen');
const RecurringScreen = lazyScreen(() => import('@/features/recurring/RecurringScreen'), 'RecurringScreen');
const RecurringDetailScreen = lazyScreen(() => import('@/features/recurring/RecurringDetailScreen'), 'RecurringDetailScreen');
const RecurringSuggestionsScreen = lazyScreen(() => import('@/features/recurring/RecurringSuggestionsScreen'), 'RecurringSuggestionsScreen');

/** a list route: the list stays mounted while a detail child slides in beside it at lg (§4.2) */
const masterDetail = (List: LazyScreen) => withScreens(() => <MasterDetailLayout list={<List />} />, List);

/** every route, with the forced update above it all: a server that no longer speaks this build gates even a device stuck on its first sync */
function RootShell() {
  return (
    <>
      <Outlet />
      <UpdateGate />
    </>
  );
}
const rootRoute = createRootRoute({ component: RootShell });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: () => {
    if (readSessionIdentity()) throw redirect({ to: '/home' });
  },
  component: LoginScreen,
});

/** the invitation's query as the mail carried it: the search parser reads an
 *  all-digit value as a number, which is still the same text */
function searchText(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value ? value : undefined;
}
// an invitation link (Logto's magic link, bounced in by main.tsx) is public —
// the invitee has no account yet — so a sibling of /login outside the app
// layout. No signed-in redirect on purpose: accepting is a fresh sign-in
// whoever is signed in on this device (the SDK clears its tokens first)
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite',
  component: InviteScreen,
  validateSearch: (search: Record<string, unknown>): { token?: string; email?: string } => ({
    token: searchText(search.token),
    email: searchText(search.email),
  }),
});

// everything behind the login gate lives under this pathless layout
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: ({ location }) => {
    if (readSessionIdentity()) return;
    rememberAfterLogin(location.pathname);
    throw redirect({ to: '/login' });
  },
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/home' });
  },
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/home', component: HomeScreen });
// customize flows are full screens (user request: dragging on a bottom
// sheet felt awkward; the sheet transform also sent the drag ghost adrift)
const homeCustomizeRoute = createRoute({ getParentRoute: () => appRoute, path: '/home/customize', component: HomeCustomizeScreen });
const txCustomizeRoute = createRoute({ getParentRoute: () => appRoute, path: '/tx-customize', component: TxDetailCustomizeScreen });
// #334 (user): home's coming-up see-all lands on the combined recurring +
// loan list — a plain child route, so browser back returns to Home
const upcomingRoute = createRoute({ getParentRoute: () => appRoute, path: '/upcoming', component: UpcomingScreen });
const periodsRoute = createRoute({ getParentRoute: () => appRoute, path: '/periods', component: PeriodsScreen });
// list routes render the master-detail layout: the list stays mounted
// while a detail child slides in beside it at lg (animated, §4.2)
const transactionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/transactions',
  component: masterDetail(TransactionsScreen),
});
const txDetailRoute = createRoute({
  getParentRoute: () => transactionsRoute,
  path: '$txId',
  component: TxDetailScreen,
  // #126 r4: a split's parts are addressable — ?part=<partId> shows one
  // part as its own transaction page
  validateSearch: (search: Record<string, unknown>): { part?: string } =>
    typeof search.part === 'string' && search.part.length > 0 ? { part: search.part } : {},
});
// #348 (user): creating a manual transaction is a screen of its own — a
// static child, so it outranks $txId and owns the detail pane on desktop;
// a caller may stage a payment onto a counterparty (?counter=&title=)
const txCreateRoute = createRoute({
  getParentRoute: () => transactionsRoute,
  path: 'new',
  component: TxCreateScreen,
  validateSearch: (search: Record<string, unknown>): { counter?: string; title?: string } => ({
    ...(typeof search.counter === 'string' && search.counter.length > 0 ? { counter: search.counter } : {}),
    ...(typeof search.title === 'string' && search.title.length > 0 ? { title: search.title } : {}),
  }),
});
// full-screen counterpart picker (user redesign 2026-07-28) — a sibling
// of the detail under /transactions, so it owns the detail pane on
// desktop and the whole viewport on mobile
const reimburseLinkRoute = createRoute({
  getParentRoute: () => transactionsRoute,
  path: '$txId/link-reimb',
  component: ReimburseLinkScreen,
  // #126 r5: a link opened from a part page targets that part
  validateSearch: (search: Record<string, unknown>): { part?: string } =>
    typeof search.part === 'string' && search.part.length > 0 ? { part: search.part } : {},
});
const recurringRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/recurring',
  component: masterDetail(RecurringScreen),
});
// static beats the $recId param in TanStack's ranking — order here is cosmetic
const recurringSuggestionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/recurring/suggestions',
  component: RecurringSuggestionsScreen,
});
const recurringDetailRoute = createRoute({
  getParentRoute: () => recurringRoute,
  path: '$recId',
  component: RecurringDetailScreen,
});
// #168 r5 (user): a transaction opened FROM the recurring screen mounts
// under the recurring layout — at lg the recurring list stays the master
// pane beside it (like $recId above); on mobile, back lands on
// /recurring. Deeper detours from the detail (parts, peers, link-reimb)
// continue under the canonical /transactions tree by design.
const recurringTxRoute = createRoute({
  getParentRoute: () => recurringRoute,
  path: 'tx/$txId',
  component: withScreens(() => <TxDetailScreen backTo="/recurring" />, TxDetailScreen),
  validateSearch: (search: Record<string, unknown>): { part?: string } =>
    typeof search.part === 'string' && search.part.length > 0 ? { part: search.part } : {},
});
const spacesRoute = createRoute({ getParentRoute: () => appRoute, path: '/spaces', component: SpacesScreen });
const spaceSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/spaces/$spaceId',
  component: SpaceSettingsScreen,
});
const spacePeriodRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/spaces/$spaceId/period',
  component: PeriodSettingsScreen,
});
const spaceMembersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/spaces/$spaceId/members',
  component: SpaceMembersScreen,
});
const spaceAccountsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/spaces/$spaceId/accounts',
  component: SpaceAccountsScreen,
});
// #577: the space's phone bar — what follows Home, and in which order
const spaceNavigationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/spaces/$spaceId/navigation',
  component: NavigationSettingsScreen,
});
const settingsRoute =createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsScreen });
const settingsGlobalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/global',
  component: GlobalSettingsScreen,
});
const goOfflineRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/go-offline',
  component: GoOfflineScreen,
});
const reviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/review',
  component: ReviewScreen,
  // #132: a new-transactions notification lands in the ANNOUNCED space —
  // the space id rides the hash query so cold starts carry it too
  validateSearch: (search: Record<string, unknown>): { space?: string } =>
    typeof search.space === 'string' && search.space.length > 0 ? { space: search.space } : {},
});
/** #527/#528: the hubs' deep links — a party to connect (as a connection to sign in again), a connection or a no-longer-fetched account to bring into view */
const hubSearch = (search: Record<string, unknown>): { connect?: string; reconnect?: string; connection?: string; uncovered?: string } => {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const connect = text(search.connect);
  const out = { connect, reconnect: connect ? text(search.reconnect) : undefined, connection: text(search.connection), uncovered: text(search.uncovered) };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
};
const accountsRoute = createRoute({ getParentRoute: () => appRoute, path: '/accounts', component: AccountsScreen, validateSearch: hubSearch });
const categoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/categories',
  component: ManageCategoriesScreen,
});
const friendsRoute = createRoute({ getParentRoute: () => appRoute, path: '/friends', component: FriendsScreen });
const splitsRoute = createRoute({ getParentRoute: () => appRoute, path: '/splits', component: SplitsScreen });
const splitJoinRoute = createRoute({ getParentRoute: () => appRoute, path: '/splits/join/$token', component: SplitJoinScreen });
const splitDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/splits/$splitId', component: SplitDetailScreen });
const onboardingRoute = createRoute({ getParentRoute: () => appRoute, path: '/onboarding', component: OnboardingScreen });
const profileRoute = createRoute({ getParentRoute: () => appRoute, path: '/profile', component: ProfileScreen });
const devicesRoute = createRoute({ getParentRoute: () => appRoute, path: '/devices', component: DevicesScreen });
const overviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/overview/$kind', component: OverviewScreen });
const budgetsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/budgets',
  component: masterDetail(BudgetsScreen),
});
// static 'new' outranks the $budgetId param in TanStack's ranking
const budgetNewRoute = createRoute({ getParentRoute: () => appRoute, path: '/budgets/new', component: BudgetFormScreen });
const budgetDetailRoute = createRoute({ getParentRoute: () => budgetsRoute, path: '$budgetId', component: BudgetDetailScreen });
const budgetEditRoute = createRoute({ getParentRoute: () => appRoute, path: '/budgets/$budgetId/edit', component: BudgetFormScreen });
const eventsRoute = createRoute({ getParentRoute: () => appRoute, path: '/events', component: EventsScreen });
const eventDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/events/$eventId', component: EventDetailScreen });
// #144: attaching is a full screen, not a sheet
const eventAttachRoute = createRoute({ getParentRoute: () => appRoute, path: '/events/$eventId/attach', component: EventAttachScreen });
// #570: adding from every transaction, dated event or not
const eventAddRoute = createRoute({ getParentRoute: () => appRoute, path: '/events/$eventId/add', component: EventAddScreen });
const goalsRoute = createRoute({ getParentRoute: () => appRoute, path: '/goals', component: GoalsScreen });
const goalDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/goals/$goalId', component: GoalDetailScreen });
// #455: picking what paid for a goal is a full screen, like attaching to an event
const goalCashOutRoute = createRoute({ getParentRoute: () => appRoute, path: '/goals/$goalId/cashout', component: GoalCashOutScreen });
const debtsRoute = createRoute({ getParentRoute: () => appRoute, path: '/debts', component: DebtsScreen });
const debtDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/debts/$debtId', component: DebtDetailScreen });
const debtPlanRoute = createRoute({ getParentRoute: () => appRoute, path: '/debts/plan', component: DebtPlanScreen });
const planningRoute = createRoute({ getParentRoute: () => appRoute, path: '/planning', component: PlanningScreen });
const helpRoute = createRoute({ getParentRoute: () => appRoute, path: '/help', component: HelpIndexScreen });
const connectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/connections',
  component: ConnectionsScreen,
  // #445: an accounts sheet's Reconnect door names the party; the hub opens the flow for it —
  // and the connection to sign in again as, so the sign-in reuses it instead of making a second one (prod 2026-10-08)
  validateSearch: hubSearch,
});
const agentsRoute = createRoute({ getParentRoute: () => appRoute, path: '/connections/agents', component: AgentsScreen });
const receiptsRoute = createRoute({ getParentRoute: () => appRoute, path: '/receipts', component: ReceiptsScreen });
/** one receipt full screen, from a space: `from` is the transaction it was opened on (its own row is noise there) */
function SpaceReceipt() {
  const { receiptId } = receiptDetailRoute.useParams();
  const { from } = receiptDetailRoute.useSearch();
  return <ReceiptScreen scope="space" receiptId={receiptId} contextTxId={from} />;
}
const receiptDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/receipts/$receiptId',
  component: withScreens(SpaceReceipt, ReceiptScreen),
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
});
// the hub's own receipts: global, no space in between
const connectionReceiptsRoute = createRoute({ getParentRoute: () => appRoute, path: '/connections/receipts', component: ConnectionReceiptsScreen });
function ConnectionReceipt() {
  const { receiptId } = connectionReceiptDetailRoute.useParams();
  return <ReceiptScreen scope="global" receiptId={receiptId} />;
}
const connectionReceiptDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/connections/receipts/$receiptId', component: withScreens(ConnectionReceipt, ReceiptScreen) });
const portfolioRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/portfolio',
  component: masterDetail(PortfolioScreen),
});
const holdingDetailRoute = createRoute({ getParentRoute: () => portfolioRoute, path: '$holdingId', component: HoldingDetailScreen });
const insightsRoute = createRoute({ getParentRoute: () => appRoute, path: '/insights', component: InsightsScreen });
const trendsRoute = createRoute({ getParentRoute: () => appRoute, path: '/trends', component: TrendsScreen });
const categoryDrillRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/overview/$kind/$catId',
  // #351 (user): a master-detail host — at lg a tapped transaction opens
  // in the right pane while this drill stays put
  component: masterDetail(CategoryDrillScreen),
  // the overview hands over its selected period
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
});
/** #351: the transaction page under the overview tree (the recurring
 *  tx/$txId precedent) — back returns to the drill, period intact */
function OverviewTxDetail() {
  const { kind, catId } = overviewTxRoute.useParams();
  const navigate = useNavigate();
  // user request 2026-10-06: the counterpart (and every other detour from
  // the detail) stays under the drill instead of jumping to the Transactions tab
  const openTx = useCallback(
    (txId: string, part?: string) =>
      void navigate({ to: '/overview/$kind/$catId/tx/$txId', params: { kind, catId, txId }, search: part ? { part } : {} }),
    [navigate, kind, catId],
  );
  return <TxDetailScreen backTo={`/overview/${kind}/${catId}`} openTx={openTx} />;
}
const overviewTxRoute = createRoute({
  getParentRoute: () => categoryDrillRoute,
  path: 'tx/$txId',
  component: withScreens(OverviewTxDetail, TxDetailScreen),
  validateSearch: (search: Record<string, unknown>): { part?: string; from?: string } => ({
    ...(typeof search.part === 'string' && search.part.length > 0 ? { part: search.part } : {}),
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  appRoute.addChildren([
    indexRoute,
    homeRoute,
    homeCustomizeRoute,
    txCustomizeRoute,
    upcomingRoute,
    periodsRoute,
    transactionsRoute.addChildren([txCreateRoute, txDetailRoute, reimburseLinkRoute]),
    recurringRoute.addChildren([recurringDetailRoute, recurringTxRoute]),
    recurringSuggestionsRoute,
    spacesRoute,
    spaceSettingsRoute,
    spacePeriodRoute,
    spaceMembersRoute,
    spaceAccountsRoute,
    spaceNavigationRoute,
    settingsRoute,
    settingsGlobalRoute,
    goOfflineRoute,
    reviewRoute,
    accountsRoute,
    categoriesRoute,
    friendsRoute,
    splitsRoute,
    splitJoinRoute,
    splitDetailRoute,
    onboardingRoute,
    profileRoute,
    devicesRoute,
    overviewRoute,
    categoryDrillRoute.addChildren([overviewTxRoute]),
    budgetsRoute.addChildren([budgetDetailRoute]),
    budgetNewRoute,
    budgetEditRoute,
    eventsRoute,
    eventDetailRoute,
    eventAttachRoute,
    eventAddRoute,
    goalsRoute,
    goalDetailRoute,
    goalCashOutRoute,
    debtsRoute,
    debtPlanRoute,
    debtDetailRoute,
    planningRoute,
    helpRoute,
    connectionsRoute,
    agentsRoute,
    receiptsRoute,
    receiptDetailRoute,
    connectionReceiptsRoute,
    connectionReceiptDetailRoute,
    portfolioRoute.addChildren([holdingDetailRoute]),
    insightsRoute,
    trendsRoute,
  ]),
]);

/** the app's router over a history — the test harness builds the same one over memory */
export function createAppRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    // #554: a hovered or touched link fetches its screen before the tap lands;
    // a chunk slower than the router's pending delay shows a spinner in the shell
    defaultPreload: 'intent',
    defaultPendingComponent: ScreenPending,
  });
}

// Hash history: works on any static host (GitHub Pages, nginx) without
// rewrite rules. Swap for createBrowserHistory once nginx hosting lands.
export const router = createAppRouter(createHashHistory());

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
