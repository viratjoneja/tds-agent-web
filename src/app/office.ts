/**
 * Office portal integration (tools.ykjoneja.com/tds): staff sign-in.
 * Not engine code. Uses the same Firebase project as TRUE GST, so a staff member signed in
 * there is already signed in here (same web address).
 * v2.4.1: the run log (one Firestore line per downloaded return) is switched off - the firm's office
 * system is where work is logged, and the TDS tool stores nothing outside the browser.
 */
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, type User } from 'firebase/auth';
import cfg from './firebase-config.json';

export const OFFICE_DOMAIN = 'ykjoneja.com';
const app = initializeApp(cfg);
export const auth = getAuth(app);

export function isOfficeUser(u: User | null): boolean {
  return !!u && !!u.email && u.emailVerified
    && u.providerData.some(p => p.providerId === 'google.com')
    && u.email.toLowerCase().endsWith('@' + OFFICE_DOMAIN);
}

export async function signInOffice(): Promise<string | null> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: OFFICE_DOMAIN, prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  if (!isOfficeUser(cred.user)) { await signOut(auth); return `Please sign in with your @${OFFICE_DOMAIN} office account.`; }
  return null;
}

/** ID token for our own /api routes; the server checks it. */
export async function authHeader(): Promise<Record<string, string>> {
  const u = auth.currentUser;
  return u ? { Authorization: `Bearer ${await u.getIdToken()}` } : {};
}
