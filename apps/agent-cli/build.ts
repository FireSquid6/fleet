import fs from "fs";


if (!fs.existsSync("./out")) {
  fs.mkdirSync("./out");
}

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./out",
  compile: true,
});

if (result.success) {
  fs.renameSync("./out/src", "./out/fleet-agent");
}

console.log(result);


