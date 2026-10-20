import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type AppConfig, api, setToken } from "./api.ts";
import { connectWallet, signXdr } from "./wallet.ts";

interface Me {
  user: { id: string; address: string; isArbiter: boolean };
  agents: { id: string; name: string; payout_address: string; status: string }[];
}

interface Session {
  config: AppConfig | null;
  configError: string | null;
  me: Me | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refreshMe(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);
const KEY = "agentflow.session";

function stored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function store(value: string | null) {
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the session lasts for this page only
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const res = await api<Me & { kind: string }>("GET", "/me");
      setMe(res.kind === "user" ? res : null);
    } catch {
      setToken(null);
      store(null);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    api<AppConfig>("GET", "/config").then(setConfig, (e: Error) => setConfigError(e.message));
    const token = stored();
    if (token) {
      setToken(token);
      void refreshMe();
    }
  }, [refreshMe]);

  const signIn = useCallback(async () => {
    if (!config) throw new Error("configuration not loaded");
    const address = await connectWallet(config.network);
    const { transaction } = await api<{ transaction: string }>("POST", "/auth/challenge", {
      address,
    });
    const signed = await signXdr(transaction, config.network, address);
    const { token } = await api<{ token: string }>("POST", "/auth/token", { transaction: signed });
    setToken(token);
    store(token);
    await refreshMe();
  }, [config, refreshMe]);

  const signOut = useCallback(async () => {
    await api("POST", "/auth/logout").catch(() => {});
    setToken(null);
    store(null);
    setMe(null);
  }, []);

  return (
    <Ctx.Provider value={{ config, configError, me, signIn, signOut, refreshMe }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
