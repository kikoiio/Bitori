import {readFileSync} from 'node:fs';
const content = readFileSync('notes/todo.md', 'utf8');
if (!content.includes('买燕麦奶') || content.includes('买牛奶')) throw new Error('todo.md 未正确修改');
