import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { User } from "oidc-client-ts";
import { userManager } from "../lib/auth";

type AuthContextValue = {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(userManager));

  useEffect(() => {
    const mgr = userManager;
    if (!mgr) {
      setIsLoading(false);
      return;
    }

    mgr.getUser()
      .then((u) => setUser(u))
      .catch(() => {})
      .finally(() => setIsLoading(false));

    const onLoaded = (u: User) => setUser(u);
    const onUnloaded = () => setUser(null);
    const onExpired = () => setUser(null);

    mgr.events.addUserLoaded(onLoaded);
    mgr.events.addUserUnloaded(onUnloaded);
    mgr.events.addAccessTokenExpired(onExpired);

    return () => {
      mgr.events.removeUserLoaded(onLoaded);
      mgr.events.removeUserUnloaded(onUnloaded);
      mgr.events.removeAccessTokenExpired(onExpired);
    };
  }, []);

  const login = () =>
    userManager ? userManager.signinRedirect() : Promise.resolve();

  const logout = () => {
    if (userManager) return userManager.signoutRedirect();
    const uri = import.meta.env.VITE_LOGOUT_URI as string | undefined;
    if (uri) window.location.href = uri;
    return Promise.resolve();
  };

  const isAuthenticated = !userManager || user !== null;

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
