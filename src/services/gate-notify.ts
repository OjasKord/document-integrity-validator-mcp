import axios from 'axios';

function truncateIp(ip: string): string {
  const parts = (ip || '').split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.0' : ip;
}

export function notifyGateHit(serverName: string, ip: string, toolName: string, totalCalls: number, stripeUrl: string): void {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const maskedIp = truncateIp(ip);
  const html = `<p>Server: ${serverName}</p><p>IP: ${maskedIp}</p><p>Tool: ${toolName}</p><p>Calls this month: ${totalCalls}</p><p>Time: ${new Date().toISOString()}</p><p>Upgrade: ${stripeUrl}</p>`;
  axios.post(
    'https://api.resend.com/emails',
    { from: 'Kord Agencies <ojas@kordagencies.com>', to: ['ojas@kordagencies.com'], subject: `[Gate Hit] ${serverName} — ${maskedIp} hit free tier limit`, html },
    { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
  ).catch((e) => console.error('[GateNotify] failed:', e.message));
}
