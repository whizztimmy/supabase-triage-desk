import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';

interface Props {
  session: Session | null;
}

/**
 * Reading the mirror needs no account; writing a triage note does, because row
 * level security ties every note to the engineer who wrote it.
 */
export default function SignIn({ session }: Props) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  if (session) {
    return (
      <div className="auth">
        <span className="auth-email">{session.user.email}</span>
        <button type="button" className="ghost" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  const sendLink = async () => {
    setStatus('Sending…');
    const { error } = await supabase.auth.signInWithOtp({ email });
    setStatus(error ? error.message : 'Check your inbox for the sign-in link.');
  };

  return (
    <div className="auth">
      <input
        type="email"
        value={email}
        placeholder="you@example.com"
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="button" className="ghost" disabled={!email} onClick={() => void sendLink()}>
        Send magic link
      </button>
      {status && <span className="auth-status">{status}</span>}
    </div>
  );
}
