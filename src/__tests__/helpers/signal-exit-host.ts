// A host that listens for termination signals the way the app does (`exitOnSignals`,
// src/assistant/sessions.ts) and only then mounts the app, whose renderer adds its own
// listener. Its chat starts a background task the scripted model holds; once that task
// runs, the host names its sessions directory in the ready file and waits for a signal.
// argv: <ready file>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exitOnSignals, runExitHooks } from '../../assistant/sessions';
import { ScriptedModel, bootApp, settle, type RecordedRequest } from './scripted';

const ready = process.argv[2]!;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-signal-exit-'));
// As the app's exit path begins: the exit hooks first, then the process goes.
exitOnSignals(() => { runExitHooks(); process.exit(0); });

const isTask = (req: RecordedRequest) => String(req.messages.find((m) => m.role === 'system')?.content ?? '').includes('Task: slow job');
const model = new ScriptedModel();
model.script([{ tool: 'subagent', args: { task: 'slow job', label: 'job' } }], [{ text: 'Started it.' }]);
const task = model.when(isTask);
task.script([{ hold: true }, { text: 'never sent' }]);
const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
await ui.press('F');
await ui.type('a question');
await ui.press('return');
for (let i = 0; i < 3000 && !(task.held && (ui.backend.lastFrame ?? '').includes('Started it.')); i++) await settle(1);
if (!task.held) { console.error('the background task never started'); process.exit(3); }
fs.writeFileSync(ready, dir);
// Nothing else keeps the process alive once the chat is idle.
setInterval(() => {}, 60_000);
