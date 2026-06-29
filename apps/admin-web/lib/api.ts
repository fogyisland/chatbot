export interface ApiClientOptions {
  baseUrl: string;
  token: string;
}

export function createApiClient(baseUrl: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };

  async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const qs = params
      ? '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    const res = await fetch(`${baseUrl}${path}${qs}`, { headers });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json();
  }

  return {
    listMessages: (p: { platform?: string; chat_id?: string; limit?: number }) =>
      get<unknown[]>('/admin/messages', p),
    listDlq: () => get<unknown[]>('/admin/dlq'),
    listUsage: (days: number) => get<unknown[]>('/admin/usage', { days }),
    replayDlq: (jobId: string) =>
      fetch(`${baseUrl}/admin/dlq/${encodeURIComponent(jobId)}/replay`, { method: 'POST', headers }).then((r) => {
        if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
        return r.json();
      }),
  };
}