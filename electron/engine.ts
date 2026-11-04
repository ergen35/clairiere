import { ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Messages come straight from the engine's JSON.
type Json = Record<string, any>;
interface Pending {
  resolve(v: Json): void;
  reject(e: Error): void;
  onEvent?: (e: Json) => void;
}

/** Talks to the Rust engine: one JSON message per line each way. */
export class Engine {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private binary: string) {}

  private ensure(): ChildProcess {
    if (this.proc) return this.proc;
    const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    const fail = (why: string) => {
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    proc.on('error', (e) => fail(`Le moteur n'a pas pu démarrer : ${e.message}`));
    proc.on('exit', () => fail("Le moteur s'est arrêté."));
    return proc;
  }

  private onLine(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.ev) {
      p.onEvent?.(msg);
      return;
    }
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  /** Sends a command; `started` hands back its id so it can be cancelled. */
  request(cmd: string, params: Json, onEvent?: (e: Json) => void, started?: (id: number) => void): Promise<Json> {
    const id = this.nextId++;
    started?.(id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      this.ensure().stdin!.write(JSON.stringify({ id, cmd, ...params }) + '\n');
    });
  }

  cancel(target: number) {
    return this.request('cancel', { target });
  }

  stop() {
    this.proc?.kill();
  }
}
