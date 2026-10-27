import type { Metadata } from 'next';
import { CeremonyApp } from '@/components/ceremony/ceremony-app';

export const metadata: Metadata = { title: 'Tina — stage' };

// Tina on the TV, opened by Start ceremony on the settings page (which keeps the host
// panel on the laptop). Password-protected by middleware.ts.
export default function CeremonyStagePage() {
  return <CeremonyApp agentName={process.env.AGENT_NAME} mode="stage" />;
}
