import fs from "fs";


if (!fs.existsSync("./out")) {
  fs.mkdirSync("./out");
}

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./out",
  compile: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

fs.renameSync("./out/src", "./out/fagent");
console.log(result);
