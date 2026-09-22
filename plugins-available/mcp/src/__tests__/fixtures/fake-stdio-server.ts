// A fake MCP server over stdio, for the plugin's tests: newline-delimited JSON-RPC on
// stdin and stdout, as `safaridriver --mcp` speaks it. Run as `bun fake-stdio-server.ts
// [mode…]`. Not a test file itself (no `.test.` in the name), and outside the typecheck
// (the plugin's tsconfig leaves `__tests__` out).
//
// Modes:
//   --noise        print lines that are not JSON-RPC before every answer
//   --silent       read everything, answer nothing
//   --die-on-call  on tools/call, write to stderr and exit with code 3
//   --ignore-term  survive SIGTERM (only SIGKILL stops it)
//   --slow-call    answer tools/call after 300 ms
//   --ignore-eof   keep running when stdin closes (a server that only a signal stops —
//                  so a test can tell our kill from the pipe closing on its own)
//
// It prints its pid to stderr on start, so a test can see it there too.

const modes = new Set(process.argv.slice(2));
if (modes.has('--ignore-term')) process.on('SIGTERM', () => { /* ignored on purpose */ });

process.stderr.write(`fake server ${process.pid} started\n`);

const tools = [
  { name: 'list_tabs', description: 'List the open tabs', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'navigate_to_url', description: 'Open a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'env', description: 'Echo an environment variable', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
];

function send(msg: unknown) {
  if (modes.has('--noise')) process.stdout.write('Safari is warming up…\n{not json at all\n\n');
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function answer(msg: { id?: number; method?: string; params?: any }) {
  if (msg.id === undefined) return; // a notification
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion, serverInfo: { name: 'Safari', version: '1.0.0' }, capabilities: { tools: {} } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    if (modes.has('--die-on-call')) {
      process.stderr.write('lost the connection to Safari\n');
      process.exit(3);
    }
    const { name, arguments: args } = msg.params ?? {};
    const text = name === 'env' ? `${args?.name}=${process.env[args?.name] ?? '(unset)'}` : `called ${name} with ${JSON.stringify(args ?? {})}`;
    const reply = () => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } });
    if (modes.has('--slow-call')) setTimeout(reply, 300);
    else reply();
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim() || modes.has('--silent')) continue;
    answer(JSON.parse(line));
  }
});
// The client going away closes our stdin: an MCP stdio server exits then.
// Staying is bounded all the same: a test that fails must not leave it running for good.
if (modes.has('--ignore-eof')) setTimeout(() => process.exit(9), 20_000);
else process.stdin.on('end', () => process.exit(0));
