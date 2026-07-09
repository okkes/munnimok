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
  // overview drill-down: category + period land here as search params
  validateSearch: (search: Record<string, unknown>): { catId?: string; from?: string; to?: string } => ({
    catId: typeof search.catId === 'string' ? search.catId : undefined,
    from: typeof search.from === 'string' ? search.from : undefined,
    to: typeof search.to === 'string' ? search.to : undefined,
  }),
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
