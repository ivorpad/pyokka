/**
 * Finding Python executables without running any: a bare name through PATH as a shell finds it,
 * Apple's /usr/bin placeholder (running it opens the "install Command Line Tools" dialog instead of
 * Python), a workspace's venv, and the places Python installs put executables on macOS and Linux,
 * for the interpreter picker. File checks only; nothing here starts a process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The first executable `name` on `pathVar`, as a shell finds it; a name with a path separator is returned as it is. */
export function whichSync(name: string, pathVar = process.env['PATH'] ?? ''): string | undefined {
  if (name.includes('/') || name.includes('\\')) return name;
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)) return full;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}

const APPLE_PLACEHOLDERS = new Set(['/usr/bin/python3', '/usr/bin/python']);

/** The developer directories whose `usr/bin/python3` Apple's placeholder hands over to: the selected one, then the usual two. */
function developerDirs(): string[] {
  const out: string[] = [];
  try {
    out.push(fs.readlinkSync('/var/db/xcode_select_link'));
  } catch {
    // xcode-select never chose one
  }
  out.push('/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer');
  return out;
}

export interface PlaceholderCheck {
  platform?: NodeJS.Platform;
  pathVar?: string;
  exists?: (file: string) => boolean;
  devDirs?: string[];
}

/**
 * Apple's /usr/bin/python3 (or a bare `python3` that resolves to it) with neither the Command Line
 * Tools nor Xcode behind it. Running it opens the "install developer tools" dialog instead of
 * Python, so Pyokka never runs it to ask its version.
 */
export function isApplePlaceholder(exe: string, o: PlaceholderCheck = {}): boolean {
  if ((o.platform ?? process.platform) !== 'darwin') return false;
  const found = whichSync(exe, o.pathVar);
  if (!found) return false;
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {
    // keep the path as found
  }
  if (!APPLE_PLACEHOLDERS.has(found) && !APPLE_PLACEHOLDERS.has(real)) return false;
  const exists = o.exists ?? fs.existsSync;
  return !(o.devDirs ?? developerDirs()).some((dir) => exists(path.join(dir, 'usr', 'bin', 'python3')));
}

/** true when the executable lives inside a virtual environment (pyvenv.cfg next to bin/) */
export function isVenvExecutable(exe: string): boolean {
  const dir = path.dirname(exe);
  return fs.existsSync(path.join(dir, '..', 'pyvenv.cfg')) || fs.existsSync(path.join(dir, 'pyvenv.cfg')) || /[\\/](\.venv|venv|\.virtualenvs)[\\/]/.test(exe);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A folder's own venv interpreter: `.venv`, then `venv` (POSIX `bin/python`, Windows `Scripts\python.exe`). */
export function workspaceVenvs(folders: readonly string[]): string[] {
  const out: string[] = [];
  for (const folder of folders) {
    for (const venv of ['.venv', 'venv']) {
      for (const exe of [path.join(folder, venv, 'bin', 'python'), path.join(folder, venv, 'Scripts', 'python.exe')]) {
        if (isFile(exe) && fs.existsSync(path.join(folder, venv, 'pyvenv.cfg'))) out.push(exe);
      }
    }
  }
  return out;
}

export interface InstallPlaces {
  home?: string;
  platform?: NodeJS.Platform;
  /** directories with versioned `python3.N` executables (Homebrew, python.org links, the system, uv) */
  binDirs?: string[];
  /** macOS python.org framework versions directory */
  frameworks?: string;
}

/**
 * Executables where Python installs put them, one level deep: versioned `python3.N` in Homebrew's,
 * the system's and uv's bin directories, python.org frameworks, pyenv and uv versions, and conda
 * bases and envs. Newest names first within each place; nothing is run.
 */
export function installedInterpreters(o: InstallPlaces = {}): string[] {
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  const list = (dir: string, re: RegExp): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => re.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  };
  const out: string[] = [];
  for (const dir of o.binDirs ?? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin')]) out.push(...list(dir, /^python3\.\d+$/));
  if (platform === 'darwin') for (const v of list(o.frameworks ?? '/Library/Frameworks/Python.framework/Versions', /^\d+\.\d+$/)) out.push(path.join(v, 'bin', 'python3'));
  for (const root of [path.join(home, '.pyenv', 'versions'), path.join(home, '.local', 'share', 'uv', 'python')]) for (const v of list(root, /^[^.]/)) out.push(path.join(v, 'bin', 'python3'));
  for (const conda of ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].map((d) => path.join(home, d))) {
    out.push(path.join(conda, 'bin', 'python'));
    for (const env of list(path.join(conda, 'envs'), /^[^.]/)) out.push(path.join(env, 'bin', 'python'));
  }
  for (const env of list(path.join(home, '.conda', 'envs'), /^[^.]/)) out.push(path.join(env, 'bin', 'python'));
  return out.filter(isFile);
}

/** One key per interpreter: a venv's own path (its python links to the base, but it is another environment), else the real path. */
export function interpreterKey(exe: string): string {
  if (isVenvExecutable(exe)) return path.resolve(exe);
  try {
    return fs.realpathSync(exe);
  } catch {
    return path.resolve(exe);
  }
}
