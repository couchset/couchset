import {escapeIdentifier} from './keyspace';

interface PathSegment {
    name: string;
    selectors: string[];
}

/** Parse data paths, not SQL expressions. Backticks delimit literal field names. */
export const parseFieldPath = (path: string): PathSegment[] => {
    const invalid = (): never => {
        throw new Error(`Invalid field path: ${JSON.stringify(path)}`);
    };
    if (typeof path !== 'string' || !path.length || /[\x00-\x1f\x7f]/.test(path)) invalid();
    const segments: PathSegment[] = [];
    let position = 0;
    while (position < path.length) {
        let name = '';
        if (path[position] === '`') {
            position++;
            let closed = false;
            while (position < path.length) {
                const character = path[position++];
                if (character !== '`') name += character;
                else if (path[position] === '`') {
                    name += '`';
                    position++;
                } else {
                    closed = true;
                    break;
                }
            }
            if (!closed) invalid();
        } else {
            while (position < path.length && !'.[]'.includes(path[position])) {
                name += path[position++];
            }
        }
        if (!name) invalid();
        const selectors: string[] = [];
        while (path[position] === '[') {
            const end = path.indexOf(']', position + 1);
            if (end < 0) invalid();
            const selector = path.slice(position + 1, end);
            if (
                selector !== '*' &&
                (!/^(0|[1-9]\d*)$/.test(selector) || !Number.isSafeInteger(Number(selector)))
            )
                invalid();
            selectors.push(`[${selector}]`);
            position = end + 1;
        }
        segments.push({name, selectors});
        if (position === path.length) break;
        if (path[position++] !== '.' || position === path.length) invalid();
    }
    return segments;
};

export const renderFieldPath = (segments: readonly PathSegment[]): string =>
    segments.map(({name, selectors}) => escapeIdentifier(name) + selectors.join('')).join('.');
