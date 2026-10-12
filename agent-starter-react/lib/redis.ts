import { Redis } from '@upstash/redis';

// The Vercel Marketplace integration names these KV_*; plain Upstash uses UPSTASH_*.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** Null when no database is configured; callers must work without it. */
export const redis = url && token ? new Redis({ url, token }) : null;
