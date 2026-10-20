import * as path from 'node:path';

export interface PathMapping { localRoot: string; remoteRoot: string }
export interface LaunchTransport { command: string; args: string[] }
type Message = Record<string, unknown>;
const object = (value: unknown): value is Message => !!value && typeof value === 'object' && !Array.isArray(value);
const localPath = (file: string): typeof path.posix => /^[A-Za-z]:[\\/]|^\\\\/.test(file) ? path.win32 : path.posix;

/** Only protocol locations change. Source text, expressions, arguments and program values do not. */
export class TransportPaths {
  readonly mappings: PathMapping[];

  constructor(mappings: unknown) {
    if (!Array.isArray(mappings) || !mappings.length) throw new Error('A transport launch needs nonempty "pathMappings".');
    this.mappings = mappings.map((m: unknown) => {
      if (!object(m) || typeof m['localRoot'] !== 'string' || typeof m['remoteRoot'] !== 'string' ||
          !localPath(m['localRoot']).isAbsolute(m['localRoot']) || !path.posix.isAbsolute(m['remoteRoot'])) {
        throw new Error('Transport pathMappings need an absolute localRoot and an absolute POSIX remoteRoot.');
      }
      return { localRoot: localPath(m['localRoot']).normalize(m['localRoot']), remoteRoot: path.posix.normalize(m['remoteRoot']) };
    });
    for (const key of ['localRoot', 'remoteRoot'] as const) {
      const roots = this.mappings.map((m) => m[key].replace(/[\\/]+$/, '') || '/');
      if (new Set(roots).size !== roots.length) throw new Error(`Duplicate ${key} in transport pathMappings.`);
    }
  }

  toRemote(file: string, required = false): string {
    return this.translate(file, 'localRoot', required);
  }

  toLocal(file: string): string {
    return this.translate(file, 'remoteRoot', false);
  }

  private translate(file: string, from: 'localRoot' | 'remoteRoot', required: boolean): string {
    const to = from === 'localRoot' ? 'remoteRoot' : 'localRoot';
    for (const mapping of [...this.mappings].sort((a, b) => b[from].length - a[from].length)) {
      const sourcePath = from === 'localRoot' ? localPath(mapping.localRoot) : path.posix;
      const relative = sourcePath.relative(mapping[from], file);
      if (sourcePath.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${sourcePath.sep}`)) continue;
      const targetPath = to === 'localRoot' ? localPath(mapping.localRoot) : path.posix;
      return targetPath.join(mapping[to], ...relative.split(sourcePath.sep));
    }
    if (required) throw new Error(`No transport pathMappings entry covers ${file}.`);
    return file;
  }

  private location(value: unknown, direction: 'remote' | 'local', required = false): unknown {
    if (!object(value) || typeof value['path'] !== 'string') return value;
    return { ...value, path: direction === 'remote' ? this.toRemote(value['path'], required) : this.toLocal(value['path']) };
  }

  private locations(value: unknown, direction: 'remote' | 'local', required = false): unknown {
    return Array.isArray(value) ? value.map((v) => this.location(v, direction, required)) : value;
  }

  outbound(msg: Message): Message {
    if (msg['type'] === 'run') {
      const config = object(msg['config']) ? msg['config'] : {};
      return { ...msg,
        ...(msg['file'] ? { file: this.location(msg['file'], 'remote', true) } : {}),
        workspaceRoot: this.toRemote(String(msg['workspaceRoot']), true),
        projectFiles: this.locations(msg['projectFiles'], 'remote', true),
        breakpoints: this.locations(msg['breakpoints'], 'remote'),
        config: { ...config, ...(config['recordFrom'] ? { recordFrom: this.location(config['recordFrom'], 'remote') } : {}) },
      };
    }
    if (msg['type'] === 'debug' && msg['action'] === 'breakpoints') return { ...msg, set: this.locations(msg['set'], 'remote') };
    if (msg['type'] === 'definition') return this.location(msg, 'remote', true) as Message;
    return msg;
  }

  inbound(msg: Message): Message {
    const out = { ...msg };
    if (msg['type'] === 'file.instrumented') return this.location(msg, 'local') as Message;
    for (const key of ['stack', 'breakpoints', 'spentBy', 'locations']) {
      if (out[key]) out[key] = this.locations(out[key], 'local');
    }
    if (out['breakpoint']) out['breakpoint'] = this.location(out['breakpoint'], 'local');
    if (out['node']) out['node'] = this.valueNode(out['node']);
    if (out['valueBag']) out['valueBag'] = this.valueBag(out['valueBag']);
    if (Array.isArray(out['locals'])) out['locals'] = out['locals'].map((v: unknown) => object(v) && v['valueBag'] ? { ...v, valueBag: this.valueBag(v['valueBag']) } : v);
    return out;
  }

  private valueBag(value: unknown): unknown {
    return object(value) ? { ...value, data: this.valueNode(value['data']) } : value;
  }

  private valueNode(value: unknown): unknown {
    if (!object(value)) return value;
    return { ...value,
      ...(value['functionLocation'] ? { functionLocation: this.location(value['functionLocation'], 'local') } : {}),
      ...(Array.isArray(value['props']) ? { props: value['props'].map((v: unknown) => this.valueNode(v)) } : {}),
    };
  }
}
