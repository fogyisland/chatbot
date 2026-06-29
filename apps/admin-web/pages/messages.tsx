import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { createApiClient } from '../lib/api';

type MessageRow = {
  id: number;
  created_at: string;
  platform: string;
  chat_id: string;
  role: string;
  preview: string;
};

export default function Messages() {
  const router = useRouter();
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    const token = localStorage.getItem('mpcb_token');
    if (!token) { router.push('/login'); return; }
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    const params: { limit: number; platform?: string } = { limit: 100 };
    if (platform) params.platform = platform;
    createApiClient(base, token).listMessages(params).then((data) => setRows(data as MessageRow[])).catch(() => setRows([]));
  }, [platform, router]);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Messages</h1>
      <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
        <option value="">all</option>
        <option value="wechat">wechat</option>
        <option value="teams">teams</option>
        <option value="dingtalk">dingtalk</option>
      </select>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr><th>Time</th><th>Platform</th><th>Chat</th><th>Role</th><th>Content</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.platform}</td>
              <td>{r.chat_id}</td>
              <td>{r.role}</td>
              <td>{r.preview}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}