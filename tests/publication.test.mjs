import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationProblems } from '../scripts/check-publication.mjs';

test('publication guard rejects private files, personal paths, contact details and host addresses', () => {
  assert.ok(publicationProblems('runtime/api-key', '').includes('private or generated file'));
  assert.ok(publicationProblems('.codex-remote-attachments/photo.jpg', '').includes('private or generated file'));
  assert.ok(publicationProblems('data/notes/example.md', '').includes('private or generated file'));
  assert.ok(publicationProblems('.env.local', '').includes('private or generated file'));
  assert.ok(publicationProblems('README.md', ['C:', 'Users', 'someone', 'work'].join('\\')).includes('personal absolute path'));
  assert.ok(publicationProblems('README.md', ['someone', 'example.com'].join('@')).includes('email address'));
  assert.ok(publicationProblems('README.md', ['192', '168', '50', '20'].join('.')).includes('environment-specific private IPv4 address'));
  assert.deepEqual(publicationProblems('docs/network.md', 'https://<LAN_IP>:8443 and http://127.0.0.1:8787'), []);
  assert.deepEqual(publicationProblems('tests/network.test.mjs', ['192', '168', '50', '20'].join('.')), []);
});
