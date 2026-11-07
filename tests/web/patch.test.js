import assert from 'node:assert/strict';
import test from 'node:test';

import { parseUnifiedDiff } from '../../web/src/shared/patch.ts';

const MULTI_FILE_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 one
-two
+two changed
+three
@@ -10 +11 @@ tail
-old tail
+new tail
diff --git a/readme.md b/readme.md
new file mode 100644
--- /dev/null
+++ b/readme.md
@@ -0,0 +1,2 @@
+hello
+world
`;

test('unified patch разбирает файлы, хунки и номера обеих сторон', () => {
  const files = parseUnifiedDiff(MULTI_FILE_PATCH);

  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.ts');
  assert.equal(files[0].hunks.length, 2);
  assert.deepEqual(
    files[0].hunks[0].lines.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })),
    [
      { kind: 'context', oldLine: 1, newLine: 1 },
      { kind: 'del', oldLine: 2, newLine: null },
      { kind: 'add', oldLine: null, newLine: 2 },
      { kind: 'add', oldLine: null, newLine: 3 },
    ],
  );
  assert.equal(files[0].hunks[1].lines[0].oldLine, 10);
  assert.equal(files[0].hunks[1].lines[1].newLine, 11);
  assert.equal(files[1].status, 'A');
  assert.equal(files[1].path, 'readme.md');
});

test('rename, binary и отсутствие перевода строки сохраняются как метаданные', () => {
  const files = parseUnifiedDiff(`diff --git a/old name.txt b/new name.txt
similarity index 91%
rename from old name.txt
rename to new name.txt
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`);

  assert.equal(files[0].status, 'R');
  assert.equal(files[0].oldPath, 'old name.txt');
  assert.equal(files[0].path, 'new name.txt');
  assert.equal(files[0].hunks[0].lines.at(-1).kind, 'meta');
  assert.equal(files[1].binary, true);
  assert.equal(files[1].path, 'logo.png');
});

test('пустой и обрезанный patch не создают неполный хунк', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);

  const truncated = `${MULTI_FILE_PATCH}diff --git a/broken.ts b/broken.ts
--- a/broken.ts
+++ b/broken.ts
@@ -1,3 +1,3 @@
 one
-tw`;
  const files = parseUnifiedDiff(truncated);

  assert.equal(files.length, 3);
  assert.equal(files[2].path, 'broken.ts');
  assert.deepEqual(files[2].hunks, []);
});
