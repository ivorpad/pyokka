/** Attach connects to an existing debugpy DAP listener; it never starts a Python process. */
export interface AttachConfig {
  connect: { host: string; port: number };
  pathMappings?: { localRoot: string; remoteRoot: string }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Run after VS Code substitutes ${workspaceFolder}, ${input:...}, etc. */
export function parseAttach(raw: Record<string, unknown>): AttachConfig {
  if (raw['record'] !== undefined && raw['record'] !== false || raw['recordFrom'] !== undefined || raw['replay'] !== undefined) {
    throw new Error('Pyokka attach cannot record or replay a debugpy process. Use a Pyokka launch for recording.');
  }
  for (const key of ['program', 'module', 'args', 'cwd', 'env', 'envFile', 'python', 'stopOnEntry', 'breakOnException', 'libraryCode', 'transport']) {
    if (raw[key] !== undefined) throw new Error(`Pyokka attach does not apply "${key}". Keep the running server's configuration; use justMyCode and VS Code's exception breakpoints for debugpy.`);
  }
  if (raw['processId'] !== undefined || raw['listen'] !== undefined) {
    throw new Error('Pyokka attach supports an existing debugpy listener through "connect", not "processId" or "listen".');
  }
  const endpoint = raw['connect'];
  if (!object(endpoint)) throw new Error('Pyokka attach needs "connect": {"host": "127.0.0.1", "port": 5678}.');
  const port = endpoint['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Pyokka attach "connect.port" must be an integer from 1 to 65535.');
  }
  const host = endpoint['host'] === undefined ? '127.0.0.1' : endpoint['host'];
  if (typeof host !== 'string' || !host || /\s/.test(host)) {
    throw new Error('Pyokka attach "connect.host" must be a nonempty hostname or IP address without whitespace.');
  }
  const config: AttachConfig = { connect: { host, port } };
  if (raw['pathMappings'] !== undefined) {
    const mappings = raw['pathMappings'];
    if (!Array.isArray(mappings)) throw new Error('Pyokka attach "pathMappings" must be an array of {localRoot, remoteRoot} pairs.');
    config.pathMappings = mappings.map((mapping: unknown) => {
      if (!object(mapping) || typeof mapping['localRoot'] !== 'string' || !mapping['localRoot'].trim() || typeof mapping['remoteRoot'] !== 'string' || !mapping['remoteRoot'].trim()) {
        throw new Error('Each Pyokka attach "pathMappings" entry needs nonempty "localRoot" and "remoteRoot" strings.');
      }
      // Debugpy interprets remote paths. Never resolve them against this machine's cwd.
      return { localRoot: mapping['localRoot'], remoteRoot: mapping['remoteRoot'] };
    });
  }
  return config;
}
