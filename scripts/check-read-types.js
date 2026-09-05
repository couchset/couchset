// Validate public emitted declarations under strict null checking, independent
// of the repository's historical non-strict implementation compiler settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'couchset-read-types-'));
try {
    const fixture = fs
        .readFileSync(path.join(root, 'test/types/reads.fixture'), 'utf8')
        .replace(/__COUCHSET_ENTRY__/g, path.join(root, 'dist/index').replace(/\\/g, '/'))
        .replace(
            /__COUCHBASE_ENTRY__/g,
            path.join(root, 'node_modules/couchbase').replace(/\\/g, '/')
        );
    const file = path.join(directory, 'reads.ts');
    fs.writeFileSync(file, fixture);
    const result = spawnSync(
        process.execPath,
        [
            path.join(root, 'node_modules/typescript/bin/tsc'),
            '--noEmit',
            '--strict',
            '--skipLibCheck',
            '--target',
            'es2018',
            '--module',
            'commonjs',
            '--moduleResolution',
            'node',
            file,
        ],
        {stdio: 'inherit'}
    );
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
} finally {
    fs.rmSync(directory, {recursive: true, force: true});
}
