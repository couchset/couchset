import type {ModelDefinition, TypedModel} from '../next';
import {buildSelectionQuery} from '../pagination/safe-pagination';

import {parseFieldPath, renderFieldPath} from './field-path';
import type {SafeQueryOptions} from './safe-query';

export interface GeoPoint {
    lat: number;
    lon: number;
}
export interface GeoBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}
export const geoPoint = (point: GeoPoint): GeoPoint => {
    if (
        !Number.isFinite(point?.lat) ||
        !Number.isFinite(point?.lon) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lon) > 180
    ) {
        throw new Error('Geo point requires latitude [-90,90] and longitude [-180,180]');
    }
    return {lat: point.lat, lon: point.lon};
};
export const geoRadiusKm = (radius: string): number => {
    const match = /^(\d+(?:\.\d+)?)\s*(km|mi|m)$/.exec(radius);
    if (!match) throw new Error('Radius requires a nonnegative distance in km, mi, or m');
    const km = Number(match[1]) * {km: 1, mi: 1.609344, m: 0.001}[match[2]];
    if (!Number.isFinite(km)) throw new Error('Radius must be finite');
    return km;
};
export const geoBounds = (bounds: GeoBounds): GeoBounds => {
    geoPoint({lat: bounds.north, lon: bounds.east});
    geoPoint({lat: bounds.south, lon: bounds.west});
    if (bounds.south > bounds.north) throw new Error('South cannot exceed north');
    return {...bounds};
};
const wrap = (lon: number): number => ((lon + 540) % 360) - 180;
export const radiusBounds = (center: GeoPoint, km: number): GeoBounds => {
    geoPoint(center);
    if (!Number.isFinite(km) || km < 0) throw new Error('Radius must be nonnegative and finite');
    const angle = Math.min(Math.PI, km / 6371);
    const latitude = (center.lat * Math.PI) / 180;
    const south = Math.max(-90, center.lat - (angle * 180) / Math.PI);
    const north = Math.min(90, center.lat + (angle * 180) / Math.PI);
    if (south === -90 || north === 90) return {south, north, west: -180, east: 180};
    const delta = (Math.asin(Math.min(1, Math.sin(angle) / Math.cos(latitude))) * 180) / Math.PI;
    return {south, north, west: wrap(center.lon - delta), east: wrap(center.lon + delta)};
};
const boxWhere = (field: string, box: GeoBounds): any => {
    parseFieldPath(field);
    geoBounds(box);
    const lat = {[`${field}.lat`]: {$gte: box.south, $lte: box.north}};
    let lon: any =
        box.west <= box.east
            ? {[`${field}.lon`]: {$gte: box.west, $lte: box.east}}
            : {$or: [{[`${field}.lon`]: {$gte: box.west}}, {[`${field}.lon`]: {$lte: box.east}}]};
    if (box.west === -180) lon = {$or: [lon, {[`${field}.lon`]: {$eq: 180}}]};
    if (box.east === 180) lon = {$or: [lon, {[`${field}.lon`]: {$eq: -180}}]};
    return {$and: [lat, lon]};
};
export interface GeoReadOptions {
    limit?: number;
    offset?: number;
    where?: any;
    queryOptions?: SafeQueryOptions;
}

/** Explicit numeric/GSI query strategy; no Search-service dependency. */
export class ModelGeo<T> {
    constructor(
        private readonly model: TypedModel<T>,
        private readonly definition: ModelDefinition<T>
    ) {}
    withinBox(args: GeoReadOptions & {field: string; bounds: GeoBounds; strategy: 'gsi'}) {
        if (args.strategy !== 'gsi') throw new Error('ModelGeo requires explicit gsi strategy');
        return this.model.findMany({
            where: {
                $and: [boxWhere(args.field, args.bounds), args.where].filter(
                    (item) => item && Object.keys(item).length
                ),
            },
            limit: args.limit,
            offset: args.offset,
            queryOptions: args.queryOptions,
        });
    }
    async withinRadius(
        args: GeoReadOptions & {field: string; center: GeoPoint; radius: string; strategy: 'gsi'}
    ): Promise<Array<{document: T; distanceKm: number}>> {
        if (args.strategy !== 'gsi') throw new Error('ModelGeo requires explicit gsi strategy');
        const center = geoPoint(args.center);
        const radius = geoRadiusKm(args.radius);
        const field = renderFieldPath(parseFieldPath(args.field));
        const limit = args.limit === undefined ? 20 : args.limit;
        const offset = args.offset || 0;
        if (
            !Number.isSafeInteger(limit) ||
            limit < 0 ||
            !Number.isSafeInteger(offset) ||
            offset < 0
        )
            throw new Error('Invalid geo pagination');
        const where = {
            $and: [
                {_type: this.definition.name},
                this.definition.defaultWhere ||
                    (this.definition.softDelete ? {deleted: {$isMissing: true}} : {}),
                boxWhere(args.field, radiusBounds(center, radius)),
                args.where,
            ].filter((item) => item && Object.keys(item).length),
        };
        const built = buildSelectionQuery({bucketName: 'unused', where: {where}});
        const predicate = built.query.slice(built.query.indexOf(' WHERE '));
        const lat = `RADIANS(doc.${field}.lat)`;
        const lon = `RADIANS(doc.${field}.lon)`;
        const distance = `12742 * ASIN(SQRT(LEAST(1, GREATEST(0, POWER(SIN((${lat} - RADIANS($geoLat)) / 2), 2) + COS(RADIANS($geoLat)) * COS(${lat}) * POWER(SIN((${lon} - RADIANS($geoLon)) / 2), 2)))))`;
        const rows = await this.model.queryRows<{document: T; distanceKm: number}>(
            `SELECT RAW {"document": doc, "distanceKm": ${distance}} FROM ${this.model.keyspace()} AS doc${predicate} AND ${distance} <= $geoRadius ORDER BY ${distance} ASC, META(doc).id ASC LIMIT $geoLimit OFFSET $geoOffset`,
            {
                ...built.parameters,
                geoLat: center.lat,
                geoLon: center.lon,
                geoRadius: radius,
                geoLimit: limit,
                geoOffset: offset,
            },
            args.queryOptions
        );
        return rows.map((row) => ({...row, document: this.model.parse(row.document)}));
    }
}
