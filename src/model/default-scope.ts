import {ModelReadArgs} from './read-helpers';

export type DefaultWhereMode = 'default' | 'withDeleted' | 'onlyDeleted' | 'none';

export interface DefaultWhereConfig {
    defaultWhere?: any;
    mode?: DefaultWhereMode;
    softDelete?: boolean;
}

export const softDeleteDefaultWhere = (): any => ({deleted: {$isMissing: true}});

const onlyDeletedWhere = (): any => ({deleted: {$eq: true}});

const mergeWhere = (first?: any, second?: any): any => {
    if (!first) {
        return second;
    }

    if (!second) {
        return first;
    }

    return {$and: [first, second]};
};

export const defaultWhereForMode = ({
    defaultWhere,
    mode = 'default',
    softDelete = false,
}: DefaultWhereConfig): any => {
    if (mode === 'withDeleted' || mode === 'none') {
        return undefined;
    }

    if (mode === 'onlyDeleted') {
        return onlyDeletedWhere();
    }

    return defaultWhere || (softDelete ? softDeleteDefaultWhere() : undefined);
};

export const applyDefaultWhere = (
    args: ModelReadArgs = {},
    config: DefaultWhereConfig
): ModelReadArgs => {
    const scopedWhere = defaultWhereForMode(config);

    if (!scopedWhere) {
        return args;
    }

    return {
        ...args,
        where: mergeWhere(scopedWhere, args.where),
    };
};
