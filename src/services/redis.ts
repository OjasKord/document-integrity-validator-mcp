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
