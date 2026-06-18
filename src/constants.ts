export const VERSION = '1.0.16';
export const PERSIST_FILE = '/tmp/docintegrity_stats.json';
export const FREE_TIER_REDIS_KEY = 'docintegrity:free_tier_usage';
export const FREE_TIER_LIMIT = 10;
export const FREE_TIER_WARNING = 8;
export const TRIAL_EXTENSION_CALLS = 10;
export const PRO_UPGRADE_URL = 'https://buy.stripe.com/9B68wOdQx06Na04fbWebu0z';
export const ENTERPRISE_UPGRADE_URL = 'https://buy.stripe.com/00w9ASeUBdXDa048Nyebu0A';
export const ALLOWED_PAYMENT_LINK_IDS = ['plink_1TU5r4D6WvRe6sn3fFi3stnj', 'plink_1TU5rVD6WvRe6sn3z8lGWphb'];
export const LEGAL_DISCLAIMER =
  'AI-powered document consistency assessment. Results are for informational purposes only and do not constitute legal, compliance, or authentication advice. We do not log or store your document content. Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';
export const STATS_KEY = process.env.STATS_KEY ?? 'ojas2026';

export function nowISO(): string {
  return new Date().toISOString();
}
