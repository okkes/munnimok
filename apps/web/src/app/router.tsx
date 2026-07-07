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
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { ReviewScreen } from '@/features/review/ReviewScreen';
import { AccountsScreen } from '@/features/accounts/AccountsScreen';
import { ManageCategoriesScreen } from '@/features/categories/ManageCategoriesScreen';
import { FriendsScreen } from '@/features/friends/FriendsScreen';
import { AdminScreen } from '@/features/admin/AdminScreen';
import { OnboardingScreen } from '@/features/auth/OnboardingScreen';

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
const spacesRoute = createRoute({ getParentRoute: () => appRoute, path: '/spaces', component: SpacesScreen });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsScreen });
const reviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/review', component: ReviewScreen });
const accountsRoute = createRoute({ getParentRoute: () => appRoute, path: '/accounts', component: AccountsScreen });
const categoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/categories',
  component: ManageCategoriesScreen,
});
const friendsRoute = createRoute({ getParentRoute: () => appRoute, path: '/friends', component: FriendsScreen });
const adminRoute = createRoute({ getParentRoute: () => appRoute, path: '/admin', component: AdminScreen });
const onboardingRoute = createRoute({ getParentRoute: () => appRoute, path: '/onboarding', component: OnboardingScreen });

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    homeRoute,
    transactionsRoute,
    txDetailRoute,
    spacesRoute,
    settingsRoute,
    reviewRoute,
    accountsRoute,
    categoriesRoute,
    friendsRoute,
    adminRoute,
    onboardingRoute,
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
