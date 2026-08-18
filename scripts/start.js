#!/usr/bin/env node
/**
 * Dev launcher: `npm start`
 *
 * Editors' integrated terminals (VS Code, Cursor, …) often export
 * ELECTRON_RUN_AS_NODE=1, which turns `electron .` into a plain Node process
 * that exits without opening a window. Strip it before launching — on every
 * platform (the old `env -u` trick only worked in Unix shells).
 */
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // resolves to the Electron binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
    cwd: path.join(__dirname, '..')
});
child.on('close', code => process.exit(code == null ? 0 : code));
