import { useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { OFFICE_DOMAIN, auth, isOfficeUser, signInOffice } from './office.ts';

/** Shows the app only to signed-in office staff. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  useEffect(() => onAuthStateChanged(auth, async u => {
    if (u && !isOfficeUser(u)) { await signOut(auth); setMsg(`Please sign in with your @${OFFICE_DOMAIN} office account.`); setUser(null); }
    else setUser(u);
  }), []);
  if (user === undefined) return <div className="app"><p className="muted">Checking sign-in...</p></div>;
  if (!user) return (
    <div className="app">
      <section className="card">
        <h2>TDS / TCS Return Builder</h2>
        <p>Staff tools of Y. K. Joneja &amp; Co. Sign in with your office Google account.</p>
        <div className="actions left">
          <button onClick={async () => { setMsg(''); try { setMsg((await signInOffice()) ?? ''); } catch (e) { setMsg((e as Error).message); } }}>
            Sign in with @{OFFICE_DOMAIN} account
          </button>
          <a className="ghost" href="/">Back to all tools</a>
        </div>
        {msg && <div className="banner error">{msg}</div>}
      </section>
    </div>
  );
  return <>{children}</>;
}
