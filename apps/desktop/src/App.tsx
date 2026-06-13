import { useState } from 'react';

import { AuthScreen, type AuthenticatedSession, type LockReason } from './features/auth/AuthScreen';
import { VaultView } from './features/vault/VaultView';

// Top-level shell: a dark "vault" canvas (ADR-0015) hosting the auth screen
// (register/login) until authenticated, then the vault view. No secret state lives
// here — keys stay in Rust (PROJECT.md §1.2). The session carried here is the
// non-secret token + the behavioral enrollment progress (Milestone 6).
//
// `lockReason` is PRESENTATION ONLY: it remembers WHY we returned to the unlock
// screen so a continuous-auth lock can show a calm "locked for your security"
// notice. It changes no flow — the lock path (zeroize keys → re-unlock) is
// unchanged; only which message is shown differs.
export function App() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [lockReason, setLockReason] = useState<LockReason>(null);

  return (
    <div className="app-canvas">
      {session === null ? (
        <AuthScreen
          lockNotice={lockReason}
          onAuthenticated={(s) => {
            setLockReason(null);
            setSession(s);
          }}
        />
      ) : (
        <VaultView
          session={session}
          onLock={(reason) => {
            setLockReason(reason === 'risk' ? 'risk' : null);
            setSession(null);
          }}
        />
      )}
    </div>
  );
}
