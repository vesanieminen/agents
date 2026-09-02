import { execFile } from 'node:child_process';
import fs from 'node:fs';

const cache = new Map(); // cwd -> {at, branch, repo}

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, timeout: 800 }, (err, out) => resolve(err ? null : out.trim()));
    child.on('error', () => resolve(null));
  });
}

/** Branch + repo name for a local cwd, cached 30s. Null fields when not a git checkout or not on this machine. */
export async function gitInfo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { branch: null, repo: null };
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 30000) return hit;
  const [branch, remote] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    run(['config', '--get', 'remote.origin.url'], cwd),
  ]);
  let repo = null;
  if (remote) {
    const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    repo = m ? m[1].split('/')[1] : null;
  }
  const info = { at: Date.now(), branch: branch === 'HEAD' ? null : branch, repo };
  cache.set(cwd, info);
  return info;
}
