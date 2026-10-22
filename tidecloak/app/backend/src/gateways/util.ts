import { randomBytes } from "node:crypto";
import type { Clock, IdGenerator } from "../usecases/ports.js";

export { toBase64 } from "../lib/encoding.js";
export const utf8Bytes = (s: string) => new TextEncoder().encode(s);

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdGenerator = {
  id: (prefix) => `${prefix}_${randomBytes(10).toString("hex")}`,
};
