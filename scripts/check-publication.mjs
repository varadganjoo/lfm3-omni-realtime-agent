import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function publicationProblems(filename, content) {
  const problems = [];
  if (/(^|\/)(runtime|models|data|\.venv|node_modules|__pycache__|\.codex-remote-attachments|\.aws|\.codex|\.agents)(\/|$)/.test(filename) ||
      /(^|\/)\.env(?:\.|$)/.test(filename) || /\.(pem|key|pfx|p12|cer|crt|etl|pcap|pcapng|gguf|wav|mp4|webm)$/i.test(filename)) {
    problems.push('private or generated file');
  }
  if (/\.(png|jpg|jpeg|webp)$/i.test(filename)) return problems;
  if (/[A-Za-z]:[\\/](?:Users|Project[ _]Workspace)[\\/]|\/(?:Users|home)\/[^/\s]+\//i.test(content)) problems.push('personal absolute path');
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)) problems.push('email address');
  if (!filename.startsWith('tests/') && /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(content)) problems.push('environment-specific private IPv4 address');
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!files.length) throw new Error('Stage the intended public files before running this check.');
  const findings = [];
  for (const filename of files) {
    const content = execFileSync('git', ['show', ':' + filename], { maxBuffer: 20_000_000 }).toString('utf8');
    for (const problem of publicationProblems(filename, content)) findings.push(`${filename}: ${problem}`);
  }
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log(`Publication privacy check passed for ${files.length} staged files. Run a dedicated secret scanner too.`);
}
