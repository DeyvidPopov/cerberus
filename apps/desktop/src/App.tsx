import { useState } from 'react';

import { AuthScreen, type AuthenticatedSession } from './features/auth/AuthScreen';
import { VaultView } from './features/vault/VaultView';

// Top-level shell: show the auth screen (register/login) until authenticated,
// then the vault view. No secret state lives here — keys stay in Rust
// (PROJECT.md §1.2). The session carried here is the non-secret token + the
// behavioral enrollment progress (Milestone 6), shown as a banner in the vault.
export function App() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null);

  if (session === null) {
    return <AuthScreen onAuthenticated={setSession} />;
  }

  return (
    <VaultView
      session={session}
      onLock={() => {
        setSession(null);
      }}
    />
  );
}
