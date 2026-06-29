import { useState } from 'react';
import { useRouter } from 'next/router';

export default function Login() {
  const [token, setToken] = useState('');
  const router = useRouter();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (token) {
      localStorage.setItem('mpcb_token', token);
      router.push('/');
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '100px auto', fontFamily: 'system-ui' }}>
      <h2>MPChatBot Admin</h2>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="Admin API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8 }}
        />
        <button type="submit" style={{ width: '100%', padding: 8 }}>登录</button>
      </form>
    </div>
  );
}