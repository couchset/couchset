export interface ModelKeyspaceTarget {
    bucketName: string;
    scopeName?: string;
    collectionName?: string;
}

export const escapeIdentifier = (identifier: string): string =>
    `\`${identifier.replace(/`/g, '``')}\``;

const safeAlias = (alias: string): string => {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) ? alias : escapeIdentifier(alias);
};

export const bucketIdentifier = (bucketName: string): string => escapeIdentifier(bucketName);

export const keyspaceIdentifier = ({
    bucketName,
    scopeName,
    collectionName,
}: ModelKeyspaceTarget): string => {
    if (!scopeName && !collectionName) {
        return bucketIdentifier(bucketName);
    }

    return `default:${bucketIdentifier(bucketName)}.${escapeIdentifier(
        scopeName || '_default'
    )}.${escapeIdentifier(collectionName || '_default')}`;
};

export const fromTarget = (keyspace: string, alias?: string): string => {
    if (!alias) {
        return keyspace;
    }

    return `${keyspace} AS ${safeAlias(alias)}`;
};
