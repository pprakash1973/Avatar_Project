import type { Metadata } from 'next';
import { CeremonyApp } from '@/components/ceremony/ceremony-app';

export const metadata: Metadata = { title: 'Award ceremony — Tina' };

// Password-protected by middleware.ts (same ADMIN_PASSWORD as /admin).
export default function CeremonyPage() {
  return <CeremonyApp agentName={process.env.AGENT_NAME} />;
}
