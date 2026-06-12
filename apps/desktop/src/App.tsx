import { useState } from 'react';

import { AuthScreen } from './features/auth/AuthScreen';
import { VaultView } from './features/vault/VaultView';

// Top-level shell: show the auth screen (register/login) until authenticated,
// then the vault view. No secret state lives here — keys stay in Rust
// (PROJECT.md §1.2). Registration replaces M3's auto-init-on-first-unlock.
export function App() {
  const [authenticated, setAuthenticated] = useState(false);

  if (!authenticated) {
    return (
      <AuthScreen
        onAuthenticated={() => {
          setAuthenticated(true);
        }}
      />
    );
  }

  return (
    <VaultView
      onLock={() => {
        setAuthenticated(false);
      }}
    />
  );
}
