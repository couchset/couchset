import {
    Project,
    StatementedNodeStructure,
    VariableDeclarationKind,
    VariableDeclarationStructure,
    OptionalKind,
    InterfaceDeclarationStructure,
    ExportDeclarationStructure,
} from 'ts-morph';

const pathToTs = __dirname + '/../../../../client/';

interface WriteFileProps extends StatementedNodeStructure {
    filename: string;
    variables?: OptionalKind<VariableDeclarationStructure>[];
    interfaces?: OptionalKind<InterfaceDeclarationStructure>[];
    exports?: OptionalKind<ExportDeclarationStructure>[];
}

export const writeTsFile = async (props: WriteFileProps): Promise<any> => {
    const {filename, variables, interfaces, exports} = props;
    const project = new Project({
        tsConfigFilePath: `${pathToTs}/tsconfig.json`,
        skipAddingFilesFromTsConfig: true,
    });

    const sourceFile = project.createSourceFile(
        `${pathToTs}/${filename}.ts`,
        {},
        {overwrite: true}
    );

    if (variables) {
        sourceFile.addVariableStatement({
            declarationKind: VariableDeclarationKind.Const, // defaults to "let"
            isExported: true,
            declarations: variables,
        });
    }

    if (interfaces) {
        sourceFile.addInterfaces(interfaces);
    }

    if (exports) {
        sourceFile.addExportDeclarations(exports);
    }

    return await sourceFile.save();
};
