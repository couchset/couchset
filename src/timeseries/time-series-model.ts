import Model, {QueryParameters, SafeQueryOptions, AutoModelFields} from '../model';

export type TimeSeriesChunkSize = 'hour' | 'day' | 'month';
export type TimeSeriesAggregate = 'AVG' | 'SUM' | 'MIN' | 'MAX' | 'COUNT';

export interface TimeSeriesValueMapping {
    field: string;
    alias?: string;
    index?: number;
    aggregate?: TimeSeriesAggregate;
}

export interface TimeSeriesModelOptions<T = any> {
    keyField: keyof T | string;
    timeField: keyof T | string;
    values: Array<keyof T | string | TimeSeriesValueMapping>;
    chunkSize?: TimeSeriesChunkSize;
    interval?: string | number;
    model?: Model;
}

export interface TimeSeriesAppendOptions {
    chunkDate?: Date | string | number;
    chunkSize?: TimeSeriesChunkSize;
    interval?: string | number;
    writeOptions?: any;
}

export interface TimeSeriesRangeArgs {
    startDate: Date | string | number;
    endDate: Date | string | number;
    interval?: string | number;
    where?: Record<string, any>;
    order?: 'ASC' | 'DESC';
    limit?: number;
}

export interface TimeSeriesChunk<T = any> {
    id: string;
    key: string;
    [field: string]: any;
    ts_start: number;
    ts_end: number;
    ts_interval?: number;
    ts_data: any[];
    rows: T[];
}

export interface TimeSeriesQuery {
    query: string;
    params: QueryParameters;
}

const intervalUnits: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
};

const normalizeTime = (date: Date | string | number): number => {
    if (date instanceof Date) {
        return date.getTime();
    }

    if (typeof date === 'number') {
        return date;
    }

    return new Date(date).getTime();
};

export const intervalToMilliseconds = (interval: string | number): number => {
    if (typeof interval === 'number') {
        return interval;
    }

    const match = interval.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/);

    if (!match) {
        throw new Error('interval must be milliseconds or a string ending in ms, s, m, h, or d');
    }

    return Number(match[1]) * intervalUnits[match[2]];
};

const datePart = (date: Date, chunkSize: TimeSeriesChunkSize): string => {
    const year = date.getUTCFullYear();
    const pad = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hour = pad(date.getUTCHours());

    if (chunkSize === 'month') {
        return `${year}-${month}`;
    }

    if (chunkSize === 'hour') {
        return `${year}-${month}-${day}T${hour}`;
    }

    return `${year}-${month}-${day}`;
};

const valueMapping = (
    value: string | TimeSeriesValueMapping,
    index: number
): TimeSeriesValueMapping => {
    if (typeof value === 'string') {
        return {field: value, index};
    }

    return {
        ...value,
        index: typeof value.index === 'number' ? value.index : index,
    };
};

const valueAlias = (mapping: TimeSeriesValueMapping): string => mapping.alias || mapping.field;

export class TimeSeriesModel<T = any> {
    public model: Model;
    private values: TimeSeriesValueMapping[];

    constructor(public name: string, private options: TimeSeriesModelOptions<T>) {
        this.model = options.model || new Model(name);
        this.values = options.values.map((value, index) =>
            valueMapping(value as string | TimeSeriesValueMapping, index)
        );
    }

    public chunkId(
        key: string,
        date: Date | string | number = new Date(),
        chunkSize = this.options.chunkSize || 'day'
    ): string {
        const chunkDate = date instanceof Date ? date : new Date(date);

        return `${this.name}:${key}:${datePart(chunkDate, chunkSize)}`;
    }

    public buildChunk(
        key: string,
        rows: T[],
        options: TimeSeriesAppendOptions = {}
    ): TimeSeriesChunk<T> {
        if (!rows.length) {
            throw new Error('appendChunk requires at least one row');
        }

        const interval = options.interval ?? this.options.interval;
        const keyField = this.options.keyField as string;
        const timeField = this.options.timeField as string;
        const normalizedRows = rows
            .map((row: any) => ({row, time: normalizeTime(row[timeField])}))
            .sort((a, b) => a.time - b.time);
        const chunkDate = options.chunkDate || normalizedRows[0].time;
        const intervalMs = interval ? intervalToMilliseconds(interval) : undefined;
        const tsData = normalizedRows.map(({row, time}) => {
            const values = this.values.map((value) => row[value.field]);

            return intervalMs ? values : [time, ...values];
        });

        return {
            id: this.chunkId(key, chunkDate, options.chunkSize || this.options.chunkSize || 'day'),
            key,
            [keyField]: key,
            rows: normalizedRows.map((item) => item.row),
            ts_data: tsData,
            ts_end: normalizedRows[normalizedRows.length - 1].time,
            ts_interval: intervalMs,
            ts_start: normalizedRows[0].time,
        };
    }

    public async appendChunk(
        key: string,
        rows: T[],
        options: TimeSeriesAppendOptions = {}
    ): Promise<TimeSeriesChunk<T> & AutoModelFields> {
        const chunk = this.buildChunk(key, rows, options);
        let existing: TimeSeriesChunk<T> | null = null;

        try {
            existing = await this.model.findById(chunk.id);
        } catch (error) {
            existing = null;
        }

        if (existing && Array.isArray(existing.ts_data)) {
            chunk.ts_data = existing.ts_data.concat(chunk.ts_data);
            chunk.rows = (existing.rows || []).concat(chunk.rows);
            chunk.ts_start = Math.min(existing.ts_start, chunk.ts_start);
            chunk.ts_end = Math.max(existing.ts_end, chunk.ts_end);
        }

        return this.model.upsert<TimeSeriesChunk<T>>(chunk, options.writeOptions);
    }

    public rangeQuery(key: string, args: TimeSeriesRangeArgs): TimeSeriesQuery {
        const start = normalizeTime(args.startDate);
        const end = normalizeTime(args.endDate);
        const params: QueryParameters = {
            key,
            rangeEnd: end,
            rangeStart: start,
            type: this.name,
        };
        const additionalWhere = args.where || {};
        const keyField = this.options.keyField as string;
        const whereExpr = Object.keys(additionalWhere)
            .map((field) => {
                params[field] = additionalWhere[field];

                return `d.${field}=$${field}`;
            })
            .join(' AND ');
        const rangeFilter = `d._type=$type AND d.${keyField}=$key AND (d.ts_start <= $rangeEnd AND d.ts_end >= $rangeStart)`;
        const where = whereExpr ? `${rangeFilter} AND ${whereExpr}` : rangeFilter;
        const order = args.order || 'ASC';
        const limit = typeof args.limit === 'number' ? ` LIMIT ${args.limit}` : '';

        if (args.interval) {
            params.intervalMs = intervalToMilliseconds(args.interval);
            const bucket = 'IDIV(t._t, $intervalMs) * $intervalMs';
            const values = this.values.map((mapping) => {
                const aggregate = mapping.aggregate || 'AVG';

                return `${aggregate}(t._v${mapping.index}) AS ${valueAlias(mapping)}`;
            });

            return {
                params,
                query: `SELECT MILLIS_TO_TZ(bucket, "UTC") AS ${
                    this.options.timeField as string
                },bucket AS time,${values.join(
                    ','
                )} FROM ${this.model.keyspace()} AS d UNNEST _timeseries(d, {"ts_ranges": [$rangeStart, $rangeEnd]}) AS t WHERE ${where} GROUP BY ${bucket} AS bucket ORDER BY bucket ${order}${limit}`,
            };
        }

        const values = this.values.map(
            (mapping) => `t._v${mapping.index} AS ${valueAlias(mapping)}`
        );

        return {
            params,
            query: `SELECT MILLIS_TO_TZ(t._t, "UTC") AS ${
                this.options.timeField as string
            },t._t AS time,${values.join(
                ','
            )} FROM ${this.model.keyspace()} AS d UNNEST _timeseries(d, {"ts_ranges": [$rangeStart, $rangeEnd]}) AS t WHERE ${where} ORDER BY t._t ${order}${limit}`,
        };
    }

    public async range<R = any>(
        key: string,
        args: TimeSeriesRangeArgs,
        options?: SafeQueryOptions
    ): Promise<R[]> {
        const {query, params} = this.rangeQuery(key, args);

        return this.queryRows<R>(query, params, options);
    }

    public async queryRows<R = any>(
        query: string,
        params?: QueryParameters,
        options?: SafeQueryOptions
    ): Promise<R[]> {
        return this.model.queryRows<R>(query, params, options);
    }
}

export default TimeSeriesModel;
