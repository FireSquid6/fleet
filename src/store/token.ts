import YAML from "yaml"
import fs from "fs";


function readTokenYamlFile(yamlFile: string): Record<string, string> {
  const record: Record<string, string> = {};
  const text = fs.readFileSync(yamlFile).toString();
  const obj: any = YAML.parse(text);
  
  for (const property in obj) {
    const val = obj[property];
    if (typeof val !== "string") {
      throw new Error("Failed to read token file. Contains non-string values");
    }
    record[property] = val;
  }

  return record;
}


export class TokenStore {
  private yamlFile: string;

  constructor(yamlFile: string) {
    this.yamlFile = yamlFile;
  }

  get(k: string): string | undefined {
    const data = readTokenYamlFile(this.yamlFile);
    return data[k];
  }

  set(k: string, val: string): void {
    const data = readTokenYamlFile(this.yamlFile);
    data[k] = val;

    const serialized = YAML.stringify(data);
    fs.writeFileSync(this.yamlFile, serialized);
  }
}
