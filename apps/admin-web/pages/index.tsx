import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { createApiClient } from '../lib/api';

type UsageRow = {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_cost: number | null;
};

export default function Dashboard() {
  const router = useRouter();
  const [usage, setUsage] = useState<Array<UsageRow>>([]);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const token = localStorage.getItem('mpcb_token');
    if (!token) { router.push('/login'); return; }
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    createApiClient(base, token).listUsage(7).then((data) => setUsage(data as UsageRow[])).catch((e) => setError(String(e)));
  }, [router]);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Dashboard (7 days)</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr><th>Provider</th><th>Model</th><th>Prompt tokens</th><th>Completion tokens</th><th>Cost (USD)</th></tr>
        </thead>
        <tbody>
          {usage.map((u, i) => (
            <tr key={i}>
              <td>{u.provider}</td><td>{u.model}</td>
              <td>{u.prompt_tokens}</td><td>{u.completion_tokens}</td>
              <td>{u.total_cost ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}