#!/usr/bin/env node
'use strict';
require('../dist/cli').runCouchsetCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
