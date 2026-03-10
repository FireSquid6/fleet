import YAML from "yaml";

export async function readTokenFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};

  const text = await file.text();
  const obj = YAML.parse(text) ?? {};

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val !== "string") {
      throw new Error(`Token file contains non-string value for key "${key}"`);
    }
  }

  return obj as Record<string, string>;
}

// Merges multiple token files left-to-right; later files override earlier ones.
export async function mergeTokenFiles(...paths: string[]): Promise<Record<string, string>> {
  const layers = await Promise.all(paths.map(readTokenFile));
  return Object.assign({}, ...layers);
}

export class TokenStore {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async get(name: string): Promise<string | undefined> {
    const data = await readTokenFile(this.path);
    return data[name];
  }

  async set(name: string, value: string): Promise<void> {
    const data = await readTokenFile(this.path);
    data[name] = value;
    await Bun.write(this.path, YAML.stringify(data));
  }

  async delete(name: string): Promise<void> {
    const data = await readTokenFile(this.path);
    delete data[name];
    await Bun.write(this.path, YAML.stringify(data));
  }

  async list(): Promise<string[]> {
    const data = await readTokenFile(this.path);
    return Object.keys(data);
  }
}
