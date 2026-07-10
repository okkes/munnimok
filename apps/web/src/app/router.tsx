import {
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { AppLayout } from './AppLayout';
import { readSessionIdentity } from './session';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { HomeScreen } from '@/features/home/HomeScreen';
import { TransactionsScreen } from '@/features/transactions/TransactionsScreen';
import { TxDetailScreen } from '@/features/transactions/TxDetailScreen';
import { SpacesScreen } from '@/features/spaces/SpacesScreen';
import { SpaceSettingsScreen } from '@/features/spaces/SpaceSettingsScreen';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { ReviewScreen } from '@/features/review/ReviewScreen';
import { AccountsScreen } from '@/features/accounts/AccountsScreen';
import { ManageCategoriesScreen } from '@/features/categories/ManageCategoriesScreen';
import { FriendsScreen } from '@/features/friends/FriendsScreen';
import { OnboardingScreen } from '@/features/auth/OnboardingScreen';
import { OverviewScreen } from '@/features/overview/OverviewScreen';
import { CategoryDrillScreen } from '@/features/overview/CategoryDrillScreen';
import { BudgetsScreen } from '@/features/budgets/BudgetsScreen';
import { BudgetFormScreen } from '@/features/budgets/BudgetFormScreen';
import { BudgetDetailScreen } from '@/features/budgets/BudgetDetailScreen';
import { EventsScreen } from '@/features/events/EventsScreen';
import { EventDetailScreen } from '@/features/events/EventDetailScreen';
import { GoalsScreen } from '@/features/goals/GoalsScreen';
import { GoalDetailScreen } from '@/features/goals/GoalDetailScreen';
import { DebtsScreen } from '@/features/debts/DebtsScreen';
import { DebtDetailScreen } from '@/features/debts/DebtDetailScreen';
import { AllocateScreen } from '@/features/allocation/AllocateScreen';
import { HelpIndexScreen } from '@/features/help/HelpIndexScreen';
import { ShoppingConnectionsScreen } from '@/features/shopping/ShoppingConnectionsScreen';
import { ReceiptsScreen } from '@/features/shopping/ReceiptsScreen';
import { PortfolioScreen } from '@/features/portfolio/PortfolioScreen';
import { HoldingDetailScreen } from '@/features/portfolio/HoldingDetailScreen';
import { InsightsScreen } from '@/features/insights/InsightsScreen';
import { ProfileScreen } from '@/features/profile/ProfileScreen';
import { RecurringScreen } from '@/features/recurring/RecurringScreen';
import { RecurringDetailScreen } from '@/features/recurring/RecurringDetailScreen';
import { RecurringSuggestionsScreen } from '@/features/recurring/RecurringSuggestionsScreen';

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: () => {
    if (readSessionIdentity()) throw redirect({ to: '/home' });
  },
  component: LoginScreen,
});

// everything behind the login gate lives under this pathless layout
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: () => {
    if (!readSessionIdentity()) throw redirect({ to: '/login' });
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
const transactionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/transactions',
  component: TransactionsScreen,
});
const txDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/transactions/$txId',
  component: TxDetailScreen,
});
const recurringRoute = createRoute({ getParentRoute: () => appRoute, path: '/recurring', component: RecurringScreen });
// static beats the $recId param in TanStack's ranking — order here is cosmetic
const recurringSuggestionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/recurring/suggestions',
  component: RecurringSuggestionsScreen,
});
const recurringDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/recurring/$recId',
  component: RecurringDetailScreen,
});
const spacesRoute = createRoute({ getParentRoute: () => appRoute, path: '/spaces', component: SpacesScreen });
const spaceSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/spaces/$spaceId',
  component: SpaceSettingsScreen,
});
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsScreen });
const reviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/review', component: ReviewScreen });
const accountsRoute = createRoute({ getParentRoute: () => appRoute, path: '/accounts', component: AccountsScreen });
const categoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/categories',
  component: ManageCategoriesScreen,
});
const friendsRoute = createRoute({ getParentRoute: () => appRoute, path: '/friends', component: FriendsScreen });
const onboardingRoute = createRoute({ getParentRoute: () => appRoute, path: '/onboarding', component: OnboardingScreen });
const profileRoute = createRoute({ getParentRoute: () => appRoute, path: '/profile', component: ProfileScreen });
const overviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/overview/$kind', component: OverviewScreen });
const budgetsRoute = createRoute({ getParentRoute: () => appRoute, path: '/budgets', component: BudgetsScreen });
// static 'new' outranks the $budgetId param in TanStack's ranking
const budgetNewRoute = createRoute({ getParentRoute: () => appRoute, path: '/budgets/new', component: BudgetFormScreen });
const budgetDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/budgets/$budgetId', component: BudgetDetailScreen });
const budgetEditRoute = createRoute({ getParentRoute: () => appRoute, path: '/budgets/$budgetId/edit', component: BudgetFormScreen });
const eventsRoute = createRoute({ getParentRoute: () => appRoute, path: '/events', component: EventsScreen });
const eventDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/events/$eventId', component: EventDetailScreen });
const goalsRoute = createRoute({ getParentRoute: () => appRoute, path: '/goals', component: GoalsScreen });
const goalDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/goals/$goalId', component: GoalDetailScreen });
const debtsRoute = createRoute({ getParentRoute: () => appRoute, path: '/debts', component: DebtsScreen });
const debtDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/debts/$debtId', component: DebtDetailScreen });
const allocateRoute = createRoute({ getParentRoute: () => appRoute, path: '/allocate', component: AllocateScreen });
const helpRoute = createRoute({ getParentRoute: () => appRoute, path: '/help', component: HelpIndexScreen });
const shoppingRoute = createRoute({ getParentRoute: () => appRoute, path: '/shopping', component: ShoppingConnectionsScreen });
const receiptsRoute = createRoute({ getParentRoute: () => appRoute, path: '/receipts', component: ReceiptsScreen });
const portfolioRoute = createRoute({ getParentRoute: () => appRoute, path: '/portfolio', component: PortfolioScreen });
const holdingDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/portfolio/$holdingId', component: HoldingDetailScreen });
const insightsRoute = createRoute({ getParentRoute: () => appRoute, path: '/insights', component: InsightsScreen });
const categoryDrillRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/overview/$kind/$catId',
  component: CategoryDrillScreen,
  // the overview hands over its selected period
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    homeRoute,
    transactionsRoute,
    txDetailRoute,
    recurringRoute,
    recurringSuggestionsRoute,
    recurringDetailRoute,
    spacesRoute,
    spaceSettingsRoute,
    settingsRoute,
    reviewRoute,
    accountsRoute,
    categoriesRoute,
    friendsRoute,
    onboardingRoute,
    profileRoute,
    overviewRoute,
    categoryDrillRoute,
    budgetsRoute,
    budgetNewRoute,
    budgetDetailRoute,
    budgetEditRoute,
    eventsRoute,
    eventDetailRoute,
    goalsRoute,
    goalDetailRoute,
    debtsRoute,
    debtDetailRoute,
    allocateRoute,
    helpRoute,
    shoppingRoute,
    receiptsRoute,
    portfolioRoute,
    holdingDetailRoute,
    insightsRoute,
  ]),
]);

// Hash history: works on any static host (GitHub Pages, nginx) without
// rewrite rules. Swap for createBrowserHistory once nginx hosting lands.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
