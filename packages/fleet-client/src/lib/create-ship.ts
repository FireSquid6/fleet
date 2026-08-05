export const SHIP_TOKEN_BYTES = 32;

export interface CreateShipForm {
  readonly url: string;
  readonly shipToken: string;
  readonly bridgeToken: string;
}

export interface CreateShipInput {
  readonly url: string;
  readonly shipToken?: string;
  readonly bridgeToken?: string;
}

export function generateShipToken(bytes: number = SHIP_TOKEN_BYTES): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateShipTokens(): { shipToken: string; bridgeToken: string } {
  return { shipToken: generateShipToken(), bridgeToken: generateShipToken() };
}

export function createShipInput(form: CreateShipForm): CreateShipInput | null {
  const url = form.url.trim();
  if (url.length === 0) return null;

  const shipToken = form.shipToken.trim();
  const bridgeToken = form.bridgeToken.trim();
  return {
    url,
    ...(shipToken.length > 0 ? { shipToken } : {}),
    ...(bridgeToken.length > 0 ? { bridgeToken } : {}),
  };
}
