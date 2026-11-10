// The image pipeline's ordering contract: the hosts pull the moving channel tag (:dev, :latest), so only
// the newest push of a branch may move it — and the move itself must never stop half-way.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const yml = readFileSync(new URL('../../.github/workflows/release-images.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function job(id) {
  const body = yml.split(new RegExp(`^  ${id}:$`, 'm'))[1]?.split(/^  [a-z-]+:$/m)[0] ?? '';
  assert.ok(body.length > 50, `job ${id} found in release-images.yml`);
  return body;
}

function concurrency(id) {
  const m = /^    concurrency:\n      group: (.+)\n      cancel-in-progress: (true|false)$/m.exec(job(id));
  return m ? { group: m[1], cancel: m[2] === 'true' } : null;
}

test('images: a newer push of the same branch cancels the older build before it can move the channel tag back — per ref, and per architecture so the two legs of one run leave each other alone', () => {
  const why = 'two pushes a minute apart build side by side, and the older build can finish last';
  assert.deepEqual(concurrency('api-tests'), { group: 'images-${{ github.ref }}-tests', cancel: true }, why);
  assert.deepEqual(concurrency('images'), { group: 'images-${{ github.ref }}-${{ matrix.arch }}', cancel: true }, why);
  assert.match(job('images'), /^    needs: api-tests$/m, 'a cancelled test job takes its build with it');
});

test('images: the channel tag moves in the manifest job alone, which waits its turn and is never cancelled between two images', () => {
  const pushed = [...job('images').matchAll(/^          tags: (.+)$/gm)].map((m) => m[1]);
  assert.ok(pushed.length >= 7, 'every image of the build job');
  for (const tag of pushed) {
    assert.match(tag, /:\$\{\{ steps\.meta\.outputs\.channel \}\}-\$\{\{ steps\.meta\.outputs\.build \}\}-\$\{\{ matrix\.arch \}\}$/, 'a build job pushes its own staging tag only — cancelling it leaves the channel untouched');
  }
  assert.match(job('manifest'), /^    needs: images$/m);
  assert.match(job('manifest'), /-t "\$REGISTRY\/\$image:\$CHANNEL" \\/);
  assert.deepEqual(concurrency('manifest'), { group: 'images-${{ github.ref }}-manifest', cancel: false }, 'stopped half-way the channel would point at a mix of two builds');
});
