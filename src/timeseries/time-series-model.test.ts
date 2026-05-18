import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {intervalToMilliseconds, TimeSeriesModel} from './time-series-model';

interface MarketData {
    ticker: string;
    date: string;
    close: number;
    high: number;
    volume: number;
}

describe('TimeSeriesModel', () => {
    beforeEach(() => {
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {defaultCollection: () => ({})} as any;
        CouchbaseConnection.Instance.cluster = {
            query: async () => ({rows: []}),
        } as any;
    });

    it('converts interval strings to milliseconds', () => {
        expect(intervalToMilliseconds('250ms')).to.equal(250);
        expect(intervalToMilliseconds('5s')).to.equal(5000);
        expect(intervalToMilliseconds('3m')).to.equal(180000);
        expect(intervalToMilliseconds('2h')).to.equal(7200000);
        expect(intervalToMilliseconds('1d')).to.equal(86400000);
    });

    it('generates stable chunk ids by UTC day, hour, or month', () => {
        const series = new TimeSeriesModel<MarketData>('mkd', {
            chunkSize: 'day',
            keyField: 'ticker',
            timeField: 'date',
            values: ['close'],
        });

        expect(series.chunkId('AAPL', '2026-05-17T23:20:00.000Z')).to.equal(
            'mkd:AAPL:2026-05-17'
        );
        expect(series.chunkId('AAPL', '2026-05-17T23:20:00.000Z', 'hour')).to.equal(
            'mkd:AAPL:2026-05-17T23'
        );
        expect(series.chunkId('AAPL', '2026-05-17T23:20:00.000Z', 'month')).to.equal(
            'mkd:AAPL:2026-05'
        );
    });

    it('builds irregular chunks when no interval is configured', () => {
        const series = new TimeSeriesModel<MarketData>('mkd', {
            keyField: 'ticker',
            timeField: 'date',
            values: ['close', 'high'],
        });
        const chunk = series.buildChunk('AAPL', [
            {
                close: 180,
                date: '2026-05-17T10:01:00.000Z',
                high: 181,
                ticker: 'AAPL',
                volume: 100,
            },
        ]);

        expect(chunk.id).to.equal('mkd:AAPL:2026-05-17');
        expect(chunk.ts_interval).to.equal(undefined);
        expect(chunk.ts_data).to.deep.equal([[1779012060000, 180, 181]]);
    });

    it('builds regular chunks when an interval is configured', () => {
        const series = new TimeSeriesModel<MarketData>('mkd', {
            interval: '1m',
            keyField: 'ticker',
            timeField: 'date',
            values: ['close', 'volume'],
        });
        const chunk = series.buildChunk('AAPL', [
            {
                close: 180,
                date: '2026-05-17T10:01:00.000Z',
                high: 181,
                ticker: 'AAPL',
                volume: 100,
            },
        ]);

        expect(chunk.ts_interval).to.equal(60000);
        expect(chunk.ts_data).to.deep.equal([[180, 100]]);
    });

    it('builds range queries with value aliases and named parameters', () => {
        const series = new TimeSeriesModel<MarketData>('mkd', {
            keyField: 'ticker',
            timeField: 'date',
            values: ['close', {field: 'high', alias: 'dailyHigh'}],
        });
        const {query, params} = series.rangeQuery('AAPL', {
            endDate: '2026-05-17T10:10:00.000Z',
            startDate: '2026-05-17T10:00:00.000Z',
        });

        expect(query).to.equal(
            'SELECT MILLIS_TO_TZ(t._t, "UTC") AS date,t._t AS time,t._v0 AS close,t._v1 AS dailyHigh FROM `test` AS d UNNEST _timeseries(d, {"ts_ranges": [$rangeStart, $rangeEnd]}) AS t WHERE d._type=$type AND d.ticker=$key AND (d.ts_start <= $rangeEnd AND d.ts_end >= $rangeStart) ORDER BY t._t ASC'
        );
        expect(params).to.deep.equal({
            key: 'AAPL',
            rangeEnd: 1779012600000,
            rangeStart: 1779012000000,
            type: 'mkd',
        });
    });

    it('builds interval aggregation queries', () => {
        const series = new TimeSeriesModel<MarketData>('mkd', {
            keyField: 'ticker',
            timeField: 'date',
            values: [{field: 'close', aggregate: 'MAX'}],
        });
        const {query, params} = series.rangeQuery('AAPL', {
            endDate: '2026-05-17T10:10:00.000Z',
            interval: '5m',
            startDate: '2026-05-17T10:00:00.000Z',
        });

        expect(query).to.contain('MAX(t._v0) AS close');
        expect(query).to.contain('GROUP BY IDIV(t._t, $intervalMs) * $intervalMs AS bucket');
        expect(params['intervalMs']).to.equal(300000);
    });
});
