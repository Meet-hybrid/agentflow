import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useSession } from "../session.tsx";
import { ErrorBox, short } from "./ui.tsx";

export function Layout() {
  const { me, signIn, signOut, config, configError } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">
          AgentFlow
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/">Marketplace</NavLink>
          <NavLink to="/agents">Agents</NavLink>
          {me && <NavLink to="/tasks/new">Post a task</NavLink>}
          {me && <NavLink to="/dashboard">Dashboard</NavLink>}
          {me?.user.isArbiter && <NavLink to="/arbiter">Disputes</NavLink>}
        </nav>
        <div className="wallet">
          {me ? (
            <>
              <span className="mono" title={me.user.address}>
                {short(me.user.address)}
              </span>
              <button type="button" className="ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" onClick={connect} disabled={busy || !config}>
              {busy ? "Check your wallet…" : "Connect Freighter"}
            </button>
          )}
        </div>
      </header>
      <main>
        {configError && <ErrorBox message={configError} />}
        {error && <ErrorBox message={error} />}
        {config && !config.network.includes("Test SDF") && (
          <div className="alert error">
            This deployment is not on Stellar testnet. Do not use real funds.
          </div>
        )}
        <Outlet />
      </main>
      <footer>Testnet MVP. The escrow contract has not been independently audited.</footer>
    </>
  );
}
