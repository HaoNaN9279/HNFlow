"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

import { type User } from "./types";

// Re-export for consumers
export type { User };

/**
 * Authentication context provided to consuming components.
 *
 * Single-user deployment: the context always holds the default user. The
 * surface is kept stable (``user`` / ``isAuthenticated`` / ``logout`` /
 * ``refreshUser`` / ``applyUser``) so existing consumers do not need to change.
 */
interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  applyUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
  initialUser: User | null;
}

export function AuthProvider({ children, initialUser }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(initialUser);

  const isAuthenticated = user !== null;

  const applyUser = useCallback((next: User | null) => {
    setUser(next);
  }, []);

  const refreshUser = useCallback(async () => {
    // Single-user: identity is static, nothing to refresh.
  }, []);

  const logout = useCallback(async () => {
    // Single-user: there is no session to end.
    setUser(null);
  }, []);

  const value: AuthContextType = {
    user,
    isAuthenticated,
    isLoading: false,
    logout,
    refreshUser,
    applyUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access authentication context.
 * Throws if used outside AuthProvider - this is intentional for proper usage
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
