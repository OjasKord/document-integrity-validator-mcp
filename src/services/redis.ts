const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

export const REDIS_PREFIX = 'docintegrity';

export async function redisGet(key: string): Promise<unknown> {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json() as { error?: string; result?: string };
    if (data.error) console.error('[Redis] redisGet error:', data.error, 'key:', key);
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}

export async function redisSet(key: string, value: unknown): Promise<void> {
  try {
    const res = await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`,
      { method: 'GET', headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
    const data = await res.json() as { error?: string };
    if (data.error) console.error('[Redis] redisSet error:', data.error, 'key:', key);
  } catch (e) { console.error('[Redis] redisSet failed:', e); }
}

export async function redisExpire(key: string, seconds: number): Promise<void> {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${seconds}`,
      { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json() as { error?: string };
    if (data.error) console.error('[Redis] redisExpire error:', data.error, 'key:', key);
  } catch (e) { console.error('[Redis] redisExpire failed:', e); }
}

export async function redisKeys(pattern: string): Promise<string[]> {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/keys/${encodeURIComponent(pattern)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json() as { error?: string; result?: string[] };
    if (data.error) console.error('[Redis] redisKeys error:', data.error, 'pattern:', pattern);
    return data.result ?? [];
  } catch { return []; }
}

export async function redisDelete(key: string): Promise<void> {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/del/${encodeURIComponent(key)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json() as { error?: string };
    if (data.error) console.error('[Redis] redisDelete error:', data.error, 'key:', key);
  } catch (e) { console.error('[Redis] redisDelete failed:', e); }
}

export async function appendSessionLog(ip: string, tool: string): Promise<void> {
  try {
    const ipSafe = ip.replace(/:/g, '_').replace(/\s/g, '');
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `${REDIS_PREFIX}:session:${ipSafe}:${dayKey}`;
    const existing = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
    existing.push({ tool, timestamp: new Date().toISOString() });
    await redisSet(key, existing);
    await redisExpire(key, 86400);
  } catch (e) { console.error('[SessionLog] internal error:', e); }
}

export async function redisIncr(key: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/incr/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json() as { error?: string; result?: number };
    if (data.error) { console.error('[Redis] redisIncr error:', data.error, 'key:', key); return null; }
    return data.result ?? null;
  } catch (e) { console.error('[Redis] redisIncr failed:', e); return null; }
}

function truncateIp(ip: string): string {
  const parts = (ip || '').split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.0' : ip;
}

// ─── FLEET CROSS-SERVER OPERATOR DETECTION ─────────────────────────────────
export async function recordFleetGateHit(ip: string): Promise<void> {
  try {
    const ip24 = truncateIp(ip);
    const key = `fleet:ip24:${ip24}:${REDIS_PREFIX}`;
    await redisSet(key, new Date().toISOString());
    await redisExpire(key, 30 * 24 * 60 * 60);
  } catch (e) { console.error('[Fleet] recordFleetGateHit failed:', e); }
}

export async function buildCrossServerNote(ip: string): Promise<string | null> {
  try {
    const ip24 = truncateIp(ip);
    const keys = await redisKeys(`fleet:ip24:${ip24}:*`);
    if (keys.length >= 3) {
      return 'Cross-server trial extension available -- this operator is already using ' + keys.length + ' Kord Agencies MCP servers. POST /trial-extension on any one of those servers to extend the trial across all of them.';
    }
    return null;
  } catch { return null; }
}

// ─── UPTIME TRACKING (for /public-stats) ────────────────────────────────────
export async function initUptimeTracking(heartbeatKey: string, monitoringStartKey: string, intervalMs: number): Promise<void> {
  try {
    let started = await redisGet(monitoringStartKey) as string | null;
    if (!started) {
      started = new Date().toISOString();
      await redisSet(monitoringStartKey, started);
    }
    setInterval(() => { redisIncr(heartbeatKey).catch(() => {}); }, intervalMs);
  } catch (e) { console.error('[Uptime] initUptimeTracking failed:', e); }
}
