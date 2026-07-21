import { test, expect } from "bun:test";
import { parseDiff } from "../src/lib/diff/parse-diff";

test("parses a modified file with hunk, line numbers, and add/del counts", () => {
  const raw = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;
  const files = parseDiff(raw);
  expect(files).toHaveLength(1);
  const f = files[0]!;
  expect(f.status).toBe("modified");
  expect(f.path).toBe("src/app.ts");
  expect(f.additions).toBe(1);
  expect(f.deletions).toBe(1);
  expect(f.hunks).toHaveLength(1);

  const lines = f.hunks[0]!.lines;
  const del = lines.find((l) => l.kind === "del")!;
  const add = lines.find((l) => l.kind === "add")!;
  expect(del.content).toBe("const b = 2;");
  expect(del.oldLine).toBe(2);
  expect(del.newLine).toBeNull();
  expect(add.content).toBe("const b = 3;");
  expect(add.newLine).toBe(2);
  expect(add.oldLine).toBeNull();
});

test("parses a new (added) file", () => {
  const raw = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;
  const files = parseDiff(raw);
  expect(files).toHaveLength(1);
  const f = files[0]!;
  expect(f.status).toBe("added");
  expect(f.path).toBe("src/new.ts");
  expect(f.additions).toBe(2);
  expect(f.deletions).toBe(0);
});

test("parses a deleted file", () => {
  const raw = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
  const files = parseDiff(raw);
  const f = files[0]!;
  expect(f.status).toBe("deleted");
  expect(f.path).toBe("old.ts");
  expect(f.deletions).toBe(2);
});

test("parses a rename", () => {
  const raw = `diff --git a/from.ts b/to.ts
similarity index 100%
rename from from.ts
rename to to.ts
`;
  const files = parseDiff(raw);
  const f = files[0]!;
  expect(f.status).toBe("renamed");
  expect(f.oldPath).toBe("from.ts");
  expect(f.newPath).toBe("to.ts");
  expect(f.path).toBe("to.ts");
});

test("flags a binary file", () => {
  const raw = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
  const files = parseDiff(raw);
  expect(files[0]!.binary).toBe(true);
});

test("parses multiple files in one stream with stable ids", () => {
  const raw = `diff --git a/one.ts b/one.ts
index 1..2 100644
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
diff --git a/two.ts b/two.ts
new file mode 100644
index 0..3
--- /dev/null
+++ b/two.ts
@@ -0,0 +1 @@
+hello
`;
  const files = parseDiff(raw);
  expect(files.map((f) => f.id)).toEqual(["file-0", "file-1"]);
  expect(files.map((f) => f.status)).toEqual(["modified", "added"]);
  expect(files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
});

test("returns an empty list for an empty diff", () => {
  expect(parseDiff("")).toEqual([]);
});
