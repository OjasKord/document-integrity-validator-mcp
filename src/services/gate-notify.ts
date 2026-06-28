import { REDIS_PREFIX, redisGet, redisSet, redisExpire } from './redis.js';
import axios from 'axios';

function truncateIp(ip: string): string {
  const parts = (ip || '').split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.0' : ip;
}

export async function notifyGateHit(serverName: string, ip: string, toolName: string, totalCalls: number, stripeUrl: string): Promise<void> {
  const ip24 = truncateIp(ip);
  const dedupKey = REDIS_PREFIX + ':gate_email:' + ip24;
  try {
    const recent = await redisGet(dedupKey);
    if (recent) { console.error('[GateNotify] suppressed duplicate for ' + ip24); return; }
    await redisSet(dedupKey, new Date().toISOString());
    await redisExpire(dedupKey, 3600);
  } catch { /* Redis unavailable — fall through and send */ }
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const html = `<p>Server: ${serverName}</p><p>IP: ${ip24}</p><p>Tool: ${toolName}</p><p>Calls this month: ${totalCalls}</p><p>Time: ${new Date().toISOString()}</p><p>Upgrade: ${stripeUrl}</p>`;
  axios.post(
    'https://api.resend.com/emails',
    { from: 'Kord Agencies <ojas@kordagencies.com>', to: ['ojas@kordagencies.com'], subject: `[Gate Hit] ${serverName} — ${ip24} hit free tier limit`, html },
    { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
  ).catch((e) => console.error('[GateNotify] failed:', e.message));
}
