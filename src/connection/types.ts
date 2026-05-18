export interface CouchsetArgs {
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;
    proxy?: string;
    force?: boolean;
    autoReconnect?: boolean;
    reconnectIntervalMs?: number;
}

export interface ConnectionSettings {
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;
    proxy?: string;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface ConnectionHealth {
    state: ConnectionState;
    autoReconnect: boolean;
    reconnectIntervalMs: number;
    bucketName: string;
    lastError?: any;
}
