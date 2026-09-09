import { api } from '@/lib/api';

export interface HealthResponse {
  status: string;
  /** Whether this deployment offers a no-signup demo session. */
  demo?: boolean;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await api.get<HealthResponse>('/api/health');
  return data;
}
