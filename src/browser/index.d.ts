export interface AnalyticsStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface AnalyticsStartInfo {
  anonId: string;
  launch?: Record<string, string>;
  ctx?: Record<string, string | number | boolean | undefined>;
}

export interface AnalyticsClient {
  start(info: AnalyticsStartInfo): Promise<void>;
  track(name: string, props?: Record<string, unknown>): void;
  flush(): Promise<void>;
  stop(reason: 'pagehide' | 'timeout'): Promise<void>;
  readonly sessionId: string | null;
}

export function createClient(options: {
  endpoint: string;
  app: string;
  storage: AnalyticsStorage;
  send?: (url: string, body: string, beacon: boolean) => Promise<string | null>;
  now?: () => number;
  flushAt?: number;
  flushMs?: number;
  maxQueue?: number;
}): AnalyticsClient;
