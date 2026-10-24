import {execFileSync} from 'node:child_process';
execFileSync('npm', ['test'], {stdio: 'inherit'});
