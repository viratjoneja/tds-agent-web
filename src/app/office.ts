/**
 * Office portal integration (tools.ykjoneja.com/tds): staff sign-in and the run log.
 * Not engine code. Uses the same Firebase project as TRUE GST, so a staff member signed in
 * there is already signed in here (same web address).
 * Run log entries hold only the headline facts of a return (deductor, TAN, form, period, totals) -
 * never the workbook or deductee rows.
 */
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, type User } from 'firebase/auth';
import { addDoc, collection, getFirestore, serverTimestamp } from 'firebase/firestore';
import cfg from './firebase-config.json';

export const OFFICE_DOMAIN = 'ykjoneja.com';
const app = initializeApp(cfg);
export const auth = getAuth(app);
const db = getFirestore(app, (cfg as { firestoreDatabaseId?: string }).firestoreDatabaseId || '(default)');

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

export async function logTdsRun(e: { deductor: string; tan: string; form: string; fy: string | number; quarter: string | number;
  totals: Record<string, unknown> }): Promise<void> {
  const u = auth.currentUser;
  if (!u) return;
  const summary: Record<string, number | string> = { form: String(e.form) };
  for (const [k, v] of Object.entries(e.totals ?? {}).slice(0, 15)) if (typeof v === 'number') summary[k] = v;
  try {
    await addDoc(collection(db, 'runLogs'), {
      tool: 'tds', clientName: String(e.deductor ?? '').slice(0, 200), gstinOrTan: String(e.tan ?? '').slice(0, 20),
      period: `Form ${e.form} FY ${e.fy} Q${e.quarter}`.slice(0, 50), summary,
      uid: u.uid, email: u.email, createdAt: serverTimestamp(),
    });
  } catch (err) { console.error('Run log could not be saved:', err); }
}
