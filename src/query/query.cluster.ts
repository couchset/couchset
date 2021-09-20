import {QueryResult} from 'couchbase';
import CouchbaseConnection from '../connection';

/**
 * Query couchbase db
 * @param query
 *  
    const query = `
      SELECT airportname, city FROM \`travel-sample\`
      WHERE type=$1
        AND city=$2
    `;
    const options = {parameters: ['airport', 'San Jose']};
 * @param options
 */
export async function QueryCluster(query: string, options?: any): Promise<QueryResult> {
    const cluster = CouchbaseConnection.Instance.cluster;
    try {
        const result = await cluster.query(query, options);
        return result;
    } catch (error) {
        console.error('Query failed: ', error);
        throw error;
    }
}
