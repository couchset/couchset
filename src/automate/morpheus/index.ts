/**
 * Define all models that can should be morphed
 */
import {ExportDeclarationStructure, StructureKind} from 'ts-morph';
import isEmpty from 'lodash/isEmpty';
import {DocumentNode} from 'graphql';
import {toSnakeUpper} from '../../utils';
import {writeTsFile} from '../writer';
import {isDev} from '../../config';

interface ClientModels {
    name: string;
    client: Record<string, DocumentNode>;
}

/**
 * Morpheus in actions
 */
export const writeAllClientSchemas = async (clients: ClientModels[]): Promise<void> => {
    if (!isDev) {
        return;
    }
    // write each file
    const writeFilesTasks = clients.map((clt) => {
        const modelName = clt.name;
        const nameSNAKE_CASE = toSnakeUpper(modelName);

        // write fragments and all queries
        const {FRAGMENT, GET, PAGE, DELETE, CREATE, ...otherClient} = clt.client;

        const constStatements = [
            {
                name: `${nameSNAKE_CASE}_FRAGMENT`,
                value: FRAGMENT,
                leadingTrivia: `/** ${nameSNAKE_CASE} Fragment **/`,
            },
            {
                name: `${nameSNAKE_CASE}_CREATE`,
                value: CREATE,
                leadingTrivia: `/** ${nameSNAKE_CASE} Create Mutation **/`,
            },
            {name: `${nameSNAKE_CASE}_DELETE`, value: DELETE},
            {name: `${nameSNAKE_CASE}_GET`, value: GET},
            {name: `${nameSNAKE_CASE}_PAGE`, value: PAGE},
        ];

        // Add other defined queries
        for (const keyQuery of Object.keys(otherClient)) {
            if (!isEmpty(keyQuery)) {
                constStatements.push({
                    name: keyQuery,
                    value: (otherClient as any)[`${keyQuery}`],
                });
            }
        }

        return {
            filename: nameSNAKE_CASE,
            task: writeTsFile({
                filename: nameSNAKE_CASE,
                variables: constStatements.map((con) => ({
                    name: con.name,
                    initializer: JSON.stringify(con.value),
                    leadingTrivia: (writer) => {
                        writer.writeLine('\n');

                        if (con?.leadingTrivia) {
                            writer.writeLine(con.leadingTrivia);
                        }
                    },
                    trailingTrivia: (writer) => writer.writeLine('\n'),
                })),
            }),
        };
    });

    //  write all files
    await Promise.all(writeFilesTasks.map((i) => i.task));

    // write all exports
    const allFileExports: ExportDeclarationStructure[] = writeFilesTasks
        .map((i) => i.filename)
        .map((c) => ({
            kind: StructureKind.ExportDeclaration,
            //   namespaceExport: "*",
            moduleSpecifier: `./${c}`,
        }));

    // write final index file
    await writeTsFile({
        filename: 'index',
        exports: allFileExports,
    });
};
