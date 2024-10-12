export function isEdge(): boolean {
    if (typeof process !== 'undefined' && process.env.NEXT_RUNTIME === 'edge') {
        return true;
    }

    // Check for Cloudflare Workers and other Service Worker environments
    if (typeof self !== 'undefined' && self.constructor.name === 'ServiceWorkerGlobalScope') {
        return true;
    }

    // Additional checks for other edge environments can be added here
    return false;
}
