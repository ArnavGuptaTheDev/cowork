// Just enough typing for node built-ins used by the test harness (the server tsconfig uses Workers types, not @types/node).
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  }
}
declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
interface ImportMeta {
  dirname: string;
}
