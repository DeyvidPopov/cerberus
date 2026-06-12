// Health service. Business logic lives in services, not routes (PROJECT.md §4.3).
// Deliberately touches no database (milestone constraint: /health is DB-free).

export interface HealthStatus {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
  readonly timestamp: string;
}

export function getHealth(): HealthStatus {
  return {
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
