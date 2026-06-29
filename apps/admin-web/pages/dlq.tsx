import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { createApiClient } from '../lib/api';

type DlqRow = {
  job_id: string;
  payload_json: unknown;
  error_message: string | null;
  retries: number;
  created_at: string;
};

export default function Dlq() {
  const router = useRouter();
  const [rows, setRows] = useState<DlqRow[]>([]);

  async function refresh(token: string) {
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    const api = createApiClient(base, token);
    setRows(await api.listDlq() as DlqRow[]);
  }

  async function replay(jobId: string) {
    const token = localStorage.getItem('mpcb_token');
    if (!token) return;
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    await createApiClient(base, token).replayDlq(jobId);
    await refresh(token);
  }

  useEffect(() => {
    const token = localStorage.getItem('mpcb_token');
    if (!token) { router.push('/login'); return; }
    refresh(token);
  }, [router]);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Dead Letter Queue ({rows.length})</h1>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>Job ID</th><th>Error</th><th>Retries</th><th>Time</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.job_id}>
              <td>{r.job_id}</td>
              <td>{r.error_message}</td>
              <td>{r.retries}</td>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td><button onClick={() => replay(r.job_id)}>Replay</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}